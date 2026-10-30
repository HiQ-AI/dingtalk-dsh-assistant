import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {DomainFacility} from '@deepseek-ai/dsh-storage-domain'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import {openResidentStore} from '../packages/dingtalk-dsh-assistant/store.js'
import {createPlatformSchedules} from '../packages/dingtalk-dsh-assistant/platform-schedule.js'
import {fixedUnitRequestId,platformScheduleSessionId} from '../packages/dingtalk-dsh-assistant/fixed-topics.js'
import {summarizeTimeSlots} from '../packages/dingtalk-dsh-assistant/coordination-time.js'

// This is the bridge's deterministic contract fixture, not a claim that a fake
// clock drives native DSH. Real ScheduleService tests live in fixed-topics-native.
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'platform-schedule-contract-')),snapshot={tables:{},global:null}
  const facility=()=>new DomainFacility({emit(){},storage:{backend:{get:()=>({kv:{async open(){return{
    loadAll:async()=>structuredClone(snapshot),close:async()=>{},
    async putRecord(table,key,value){(snapshot.tables[table]??={})[key]=structuredClone(value)},
    async deleteRecord(table,key){delete snapshot.tables[table][key]},
  }}}})}}},{backend:'schedule-contract'})
  let store=await openResidentStore(facility()),bridge,clock=Date.parse('2026-10-21T00:00:00Z'),createCount=0
  const records=[]
  // A Host-owned session was already persisted; native scheduling belongs to the
  // injected service. We test persistence/identity calls, not its clock algorithm.
  const native={catalog:async()=>structuredClone(records),async create(sessionId,args){
    createCount++;const record={id:'native-'+createCount,sessionId,kind:'at',scheduledAt:args.at,title:args.title,prompt:args.prompt,status:'active'}
    records.push(record);return structuredClone(record)}}
  const ctx={get:name=>name==='schedule'?native:name==='sessionController'?{}:undefined,
    sessionPersistence:{stat:async()=>({})},on:()=>()=>{}}
  const open=()=>bridge=createPlatformSchedules({ctx,store,root,legacy:{getAgentConfig:()=>({agentPreset:'synthetic'})},
    now:()=>clock,readTasks:async()=>[],notify:()=>assert.fail('submission must not deliver')})
  await store.subscribe({groupId:'g',timezone:'Asia/Shanghai'})
  const text='At the agreed time report current progress'
  await store.ingest({groupId:'g',messageId:'m',text,senderOpenDingTalkId:'author',occurredAt:new Date(clock).toISOString()})
  await store.routeMessages({groupId:'g',routeId:'r',routingRevision:0,routes:[{messageId:'m',messageVersion:1,
    units:[{unitKey:'u',summary:'Scheduled report',sourceRefs:[{quote:text}],topics:[],fixedTopic:'agent-platform',reason:'Platform request'}]}]})
  const message=store.getGroup('g').messages[0],unit=message.units[0]
  const source={groupId:'g',messageId:'m',messageVersion:1,unitId:unit.unitId,unitRevision:unit.unitRevision,timezone:'Asia/Shanghai',
    requestId:fixedUnitRequestId('g',message,unit)}
  open()
  t.after(async()=>{await bridge.close();await store.close();await rm(root,{recursive:true,force:true})})
  return {source,records,native,ctx,args:{title:'Progress report',prompt:'Report current progress to the group',at:'2026-10-21T09:00:00+08:00'},
    get store(){return store},get creates(){return createCount},submit:(args,identity=source)=>bridge.submit(identity,args),
    tick:ms=>{clock+=ms},setTime:at=>{clock=Date.parse(at)},
    async restart(){await bridge.close();await store.close();store=await openResidentStore(facility());open()}}
}

test('explicit timezone offset freezes one canonical instant and one native identity through retries and restart',async t=>{
  const f=await fixture(t),first=await f.submit(f.args)
  assert.equal(first.at,'2026-10-21T01:00:00.000Z')
  assert.equal(f.records[0].kind,'at');assert.equal(f.records[0].sessionId,platformScheduleSessionId(f.source.requestId))
  const saved=structuredClone(f.store.getPlatformSchedule(f.records[0].sessionId))
  await f.restart();assert.deepEqual(await f.submit(f.args),first)
  assert.equal(f.creates,1);assert.deepEqual(f.store.getPlatformSchedule(f.records[0].sessionId),saved)
  assert.deepEqual(f.store.listTasks(),[]);assert.deepEqual(f.store.getGroup('g').outbox,[])
})

test('pure reminder keeps original prompt and source without creating a business Task or notification',async t=>{
  const f=await fixture(t),args={...f.args,prompt:'Notify the specified recipients with the agreed text'}
  await f.submit(args);await f.restart()
  const saved=f.store.getPlatformSchedule(f.records[0].sessionId)
  assert.equal(saved.prompt,args.prompt);assert.equal(saved.messageId,f.source.messageId)
  assert.equal(saved.unitId,f.source.unitId);assert.equal(saved.messageVersion,1)
  assert.equal(saved.timezone,'Asia/Shanghai');assert.deepEqual(f.store.listTasks(),[])
  assert.deepEqual(f.store.getGroup('g').outbox,[]);assert.equal(f.creates,1)
})

for(const key of ['title','prompt','at'])test(`accepted native schedule cannot silently retime or replace its frozen ${key}`,async t=>{
  const f=await fixture(t);await f.submit(f.args);const before=structuredClone(f.records)
  const value=key==='at'?'2026-10-21T02:00:00Z':'Different authorized input is a new source'
  await assert.rejects(f.submit({...f.args,[key]:value}),/platform_schedule_identity_conflict/)
  assert.deepEqual(f.records,before);assert.equal(f.creates,1)
  await f.restart();assert.deepEqual(await f.submit(f.args),{status:'scheduled',scheduleId:before[0].id,at:before[0].scheduledAt})
})

test('deleted native record is not recreated by source replay or restart',async t=>{
  const f=await fixture(t);const accepted=await f.submit(f.args);f.records.splice(0);await f.restart()
  assert.deepEqual(await f.submit(f.args),{status:'cancelled',scheduleId:accepted.scheduleId})
  assert.equal(f.creates,1);assert.deepEqual(f.records,[]);assert.deepEqual(f.store.getGroup('g').outbox,[])
})

test('native create committed before its local receipt is recovered without a second create',async t=>{
  const f=await fixture(t),original=f.store.updatePlatformSchedule
  const mock=t.mock.method(f.store,'updatePlatformSchedule',async()=>{throw new Error('lost local receipt')})
  await assert.rejects(f.submit(f.args),/lost local receipt/);mock.mock.restore()
  assert.equal(f.creates,1)
  assert.equal(f.store.getPlatformSchedule(f.records[0].sessionId).scheduleId,undefined)
  await f.restart();const recovered=await f.submit(f.args)
  assert.equal(recovered.scheduleId,f.records[0].id);assert.equal(f.creates,1)
  assert.equal(typeof original,'function')
})

test('concurrent same-source submissions serialize into one persisted schedule',async t=>{
  const f=await fixture(t),results=await Promise.all([f.submit(f.args),f.submit(f.args),f.submit(f.args)])
  assert.equal(new Set(results.map(result=>result.scheduleId)).size,1);assert.equal(f.creates,1)
  await f.restart();assert.equal((await f.submit(f.args)).scheduleId,results[0].scheduleId)
})

test('source enrichment invalidates an old schedule submission without creating a new native effect',async t=>{
  const f=await fixture(t)
  await f.store.ingest({groupId:'g',messageId:'m',messageVersion:2,senderOpenDingTalkId:'author',text:'A corrected request',occurredAt:'2026-10-21T00:00:00Z'})
  assert.equal(f.store.getGroup('g').messages[0].messageVersion,2)
  await assert.rejects(f.submit(f.args),/platform_schedule_source_stale/)
  assert.equal(f.creates,0);assert.deepEqual(f.records,[])
})

for(const [field,value] of [['groupId','other'],['messageVersion',2],['unitRevision',2]])
test(`scheduled source ${field} cannot borrow another accepted identity`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.submit(f.args,{...f.source,[field]:value}),/platform_schedule_source_stale/)
  assert.equal(f.creates,0);assert.deepEqual(f.store.getGroup('g').outbox,[])
})

for(const delayMs of [0,17000,900000,900001])test(`already due request is reported expired without silently scheduling tomorrow: delay=${delayMs}`,async t=>{
  const f=await fixture(t);f.tick(delayMs)
  const args={...f.args,at:'2026-10-21T00:00:00Z'}
  assert.deepEqual(await f.submit(args),{status:'expired',at:'2026-10-21T00:00:00.000Z'})
  await f.restart();assert.equal((await f.submit(args)).status,'expired')
  assert.equal(f.creates,0);assert.deepEqual(f.records,[]);assert.deepEqual(f.store.listTasks(),[])
})

for(const at of ['2026-10-21T01:00:00','2026-02-30T01:00:00Z'])
test(`invalid or timezone-free due instant does not create a schedule: ${at}`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.submit({...f.args,at}),/platform_schedule_time_(requires_offset|invalid)/)
  assert.equal(f.creates,0);assert.deepEqual(f.records,[])
})

test('a previously triggered native identity stays triggered after a backward clock change and restart',async t=>{
  const f=await fixture(t);await f.submit(f.args);f.records[0].status='inactive'
  f.setTime('2026-10-20T00:00:00Z');await f.restart()
  assert.equal((await f.submit(f.args)).status,'triggered')
  assert.equal(f.creates,1);assert.equal(f.records.length,1)
})

for(const [state,delivery] of [['active','prepared'],['paused','prepared'],['cancelled','unknown'],['completed','delivered']])
test(`retired periodic ${state}/${delivery} keeps history without transferring cursor or delivery to native Schedule`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'retired-periodic-')),options={dbPath:join(root,'tasks.sqlite'),instanceId:'retired-periodic',initialize:true}
  let store=await openDynamicTaskStore(options)
  t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})})
  await store.close();const db=new DatabaseSync(options.dbPath)
  const schedule={id:'old',coordinationId:'arrangement',state,revision:3,rule:{kind:'daily',time:'09:00'},timezone:'Asia/Shanghai',nextDueAt:'2026-10-21T01:00:00Z'}
  const occurrence={id:'old-slot',scheduleId:'old',acceptedScheduleRevision:2,plannedAt:'2026-10-20T01:00:00Z',target:{conversationId:'g',recipientIds:['original']},actionState:'succeeded',deliveryState:delivery}
  const notice={id:'old-notice',kind:'coordination',state:delivery,payload:{conversationId:'g',text:'Frozen old result',fact:{coordinationId:'arrangement',eventId:'old-slot'}},
    ...(delivery==='delivered'?{receipt:{messageId:'sent-once'}}:delivery==='unknown'?{ack:{openTaskId:'accepted-once'},sendAttemptCount:1}:{})}
  db.prepare("DELETE FROM dynamic_meta WHERE key='independentCoordinationRetired'").run()
  for(const [table,row] of [['coordination_schedules',schedule],['coordination_occurrences',occurrence],['notifications',notice]])
    db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?)`).run(row.id,JSON.stringify(row))
  db.close();store=await openDynamicTaskStore(options)
  const query=kind=>store.query({kind})
  const [saved]=await query('coordination.schedule.list')
  assert.equal(saved.state,state);assert.equal(saved.nextDueAt,schedule.nextDueAt)
  assert.deepEqual(saved.rule,schedule.rule);assert.equal(saved.retirement.previousState,state)
  assert.deepEqual(await query('coordination.occurrence.list'),[occurrence])
  const current=await store.query({kind:'notification.get',notificationId:notice.id})
  assert.equal(current.state,delivery==='prepared'?'superseded':delivery)
  assert.deepEqual(current.payload,notice.payload);assert.deepEqual(current.receipt,notice.receipt);assert.deepEqual(current.ack,notice.ack)
  await store.close();store=await openDynamicTaskStore(options)
  assert.deepEqual((await query('coordination.schedule.list'))[0],saved)
  assert.deepEqual(await query('coordination.job.list'),[]);assert.deepEqual(await query('task.list'),[])
})

test('retained historical time summarizer counts multi-year UTC slots exactly without creating current schedules',()=>{
  assert.deepEqual(summarizeTimeSlots({kind:'daily',time:'09:00'},'Asia/Shanghai',
    Date.parse('2024-01-01T01:00:00Z'),Date.parse('2026-01-01T01:00:00Z')),
    {latest:'2026-01-01T01:00:00.000Z',count:732})
})
