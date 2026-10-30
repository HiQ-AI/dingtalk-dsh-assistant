import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {openDynamicTaskStore} from '../packages/dingtalk-dsh-assistant/dynamic-task-store.js'
import {deliverTaskNotification,retryTaskNotification,taskNotificationRecovery} from '../packages/dingtalk-dsh-assistant/notification-delivery.js'

// Frozen Topic results are not periodically re-read by the retired coordinator.
// Recovery CAS, current question validity, and proven-not-sent retirement own the
// corresponding freshness boundaries; a clock timeout never invents new facts.
async function fixture(t){
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-21T00:00:00Z')})
  const directory=await mkdtemp(join(tmpdir(),'topic-notification-freshness-'))
  const options={dbPath:join(directory,'tasks.sqlite'),instanceId:'freshness',initialize:true}
  let store=await openDynamicTaskStore(options),sends=0
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const command=(kind,args={},id=randomUUID())=>store.command({kind,args,id})
  const query=(kind,args={})=>store.query({kind,...args})
  const input=(id='notice',extra={})=>({notificationId:id,kind:'topic-reply',requirementRevision:1,payload:{
    conversationId:'group',text:'Frozen verified result',sourceMessageId:'source',actorId:'actor',
    fact:{topicRefs:[{topicId:'topic',revision:1}]},...extra}})
  const prepare=(id,extra)=>command('notification.prepare',input(id,extra))
  const notification=(await prepare()).result.notification
  const notifications={canDisclose:async()=>true,send:async candidate=>{sends++;return{messageId:`fake:${candidate.id}`}},
    readback:async candidate=>({messageId:`fake:${candidate.id}`,visible:true,deliveryStatus:'delivered'})}
  async function rejectBeforeSend(){
    const permitted=(await command('notification.start',{notificationId:notification.id})).result.notification
    const detail={category:'api',code:1,origin:'mcp_gateway',operation:'chat/get_conversation_info',reason:'topic_quote_guard_unavailable',
      retryable:true,message:'无法确认引用回复目标是否属于话题圈，已阻止发送'}
    await command('notification.receipt',{notificationId:notification.id,dispatchToken:permitted.dispatchToken,state:'failed',
      error:{phase:'send',exitCode:1,stdout:'',stderr:JSON.stringify({error:detail}),knownNotSent:true,retryable:true}})
  }
  return {options,command,query,input,prepare,notification,rejectBeforeSend,
    read:(id=notification.id)=>query('notification.get',{notificationId:id}),
    retire:()=>command('notification.retireUnsent',{notificationId:notification.id,reason:'superseded',evidenceRef:'reviewed-new-conclusion'}),
    deliver:candidate=>deliverTaskNotification({notification:candidate,notifications,command}),
    retry:(candidate,token=taskNotificationRecovery(candidate).expectedToken)=>retryTaskNotification({notification:candidate,notifications,command,expectedToken:token}),
    get sends(){return sends},async close(){await store.close()},async restart(){await store.close();store=await openDynamicTaskStore(options)}}
}

test('manual recovery requires the current durable token, not merely an aged prepared snapshot',async t=>{
  const f=await fixture(t),token=taskNotificationRecovery(f.notification).expectedToken
  t.mock.timers.tick(300001)
  await f.command('notification.recovery.start',{notificationId:f.notification.id,expectedToken:token})
  await assert.rejects(f.retry(f.notification,token),{code:'DYNAMIC_NOTIFICATION_RECOVERY_STALE'})
  assert.equal(f.sends,0);assert.equal((await f.read()).state,'prepared')
  assert.equal((await f.read()).sendPermit,undefined)
  await f.retry(await f.read())
  assert.equal(f.sends,1);assert.deepEqual((await f.read()).payload,f.notification.payload)
})

test('an explicitly replaced unsent result keeps immutable evidence instead of fabricating a fresh query',async t=>{
  const f=await fixture(t),payload=structuredClone(f.notification.payload)
  await f.rejectBeforeSend();await f.retire()
  const fresh=(await f.prepare('replacement',{text:'New independently verified result'})).result.notification
  const old=await f.read()
  assert.equal(old.state,'failed');assert.equal(old.retirement.evidenceRef,'reviewed-new-conclusion')
  assert.deepEqual(old.payload,payload);assert.equal(taskNotificationRecovery(old).reason,'terminal')
  await f.deliver(f.notification);assert.equal(f.sends,0)
  await f.deliver(fresh);assert.equal(f.sends,1)
  assert.equal((await f.query('notification.list')).length,2)
  assert.deepEqual(await f.query('task.list'),[],'notification replacement never creates work')
})

test('permit wins: starting and recovered unknown candidates only read back, and delivered candidates never resend',async t=>{
  const f=await fixture(t)
  assert.equal((await f.command('notification.start',{notificationId:f.notification.id},'permit-once')).dispatchEligible,true)
  t.mock.timers.tick(300001)
  await assert.rejects(f.retire(),{code:'DYNAMIC_NOTIFICATION_RECONCILIATION_REQUIRED'})
  await f.restart();assert.equal((await f.read()).state,'unknown')
  assert.equal((await f.command('notification.start',{notificationId:f.notification.id},'permit-once')).dispatchEligible,false)
  await f.retry(await f.read())
  assert.equal(f.sends,0);assert.equal((await f.read()).state,'delivered')
  await assert.rejects(f.retry(await f.read()),{code:'TASK_NOTIFICATION_RECOVERY_FORBIDDEN'})
  assert.equal((await f.query('notification.list')).length,1)
})

test('retirement wins: a stale prepared outbox cannot regain a permit after restart',async t=>{
  const f=await fixture(t);await f.rejectBeforeSend();await f.retire();await f.restart()
  assert.equal((await f.command('notification.start',{notificationId:f.notification.id})).dispatchEligible,false)
  await f.deliver(f.notification);await f.deliver(await f.read())
  assert.equal(f.sends,0);assert.equal((await f.read()).sendAttemptCount,1)
  assert.deepEqual((await f.read()).payload,f.notification.payload)
  assert.equal((await f.read()).retirement.reason,'superseded')
})

test('a cancelled current human request invalidates its prepared Topic question before any send',async t=>{
  const f=await fixture(t)
  await f.command('task.create',{taskId:'A',groupId:'group',request:'Need a decision'})
  const binding=(await f.command('task.claim',{taskId:'A'})).result.binding
  await f.command('task.wait',{binding,summary:'Waiting for request details',question:'Which target?',
    humanRequest:{requestId:'question',audience:'requester',reason:'Target missing'}})
  const question=(await f.prepare('question',{text:'Which target?',humanRequests:[{taskId:'A',requestId:'question'}]})).result.notification
  await f.command('task.control',{taskId:'A',expectedControlRevision:1,control:'cancelled',reason:'User cancelled'})
  await f.deliver(question)
  const rejected=await f.read(question.id)
  assert.equal(rejected.state,'superseded');assert.equal(rejected.reason,'stale_question')
  assert.equal(rejected.sendPermit,undefined);assert.equal(f.sends,0)
  assert.equal((await f.query('task.get',{taskId:'A'})).control,'cancelled')
})

test('repeated preparation and conflicting recovery identities cannot change a frozen payload',async t=>{
  const f=await fixture(t),args=f.input()
  const receipt=await f.command('notification.prepare',args,'prepare-exact')
  assert.equal((await f.command('notification.prepare',args,'prepare-exact')).replayed,true)
  assert.equal(receipt.result.notification.id,f.notification.id)
  await assert.rejects(f.command('notification.prepare',f.input('notice',{text:'Conflicting answer'})),{code:'DYNAMIC_NOTIFICATION_ID_CONFLICT'})
  await assert.rejects(f.command('notification.prepare',f.input('other'),'prepare-exact'),{code:'DYNAMIC_COMMAND_ID_CONFLICT'})
  await f.restart()
  assert.equal((await f.query('notification.list')).length,1)
  assert.deepEqual((await f.read()).payload,f.notification.payload)
})

test('SIGKILL after preparation before outbox projection recovers the exact frozen identity only',async t=>{
  const f=await fixture(t),crashId='crash-notice';await f.close()
  const moduleUrl=new URL('../packages/dingtalk-dsh-assistant/dynamic-task-store.js',import.meta.url).href
  const script=`import {openDynamicTaskStore} from ${JSON.stringify(moduleUrl)};
    const store=await openDynamicTaskStore(JSON.parse(process.argv[1]));
    await store.command({id:'prepare-before-kill',kind:'notification.prepare',args:JSON.parse(process.argv[2])});
    process.stdout.write('prepared');setInterval(()=>{},1000);`
  const child=spawn(process.execPath,['--input-type=module','--eval',script,JSON.stringify(f.options),JSON.stringify(f.input(crashId))],{stdio:['ignore','pipe','pipe']})
  const exited=once(child,'exit');t.after(()=>child.kill('SIGKILL'))
  const ready=await Promise.race([once(child.stdout,'data').then(([chunk])=>chunk.toString()),exited.then(([code,signal])=>{throw new Error(`child exited before preparation: ${code}/${signal}`)})])
  assert.equal(ready,'prepared');child.kill('SIGKILL')
  const [code,signal]=await exited
  if(process.platform==='win32'){assert.equal(signal,null);assert.equal(code,1)}else assert.equal(signal,'SIGKILL')
  await f.restart()
  assert.deepEqual((await f.read(crashId)).payload,f.notification.payload)
  assert.equal((await f.command('notification.prepare',f.input(crashId),'prepare-before-kill')).replayed,true)
  await f.deliver(await f.read(crashId));await f.deliver(await f.read(crashId))
  assert.equal(f.sends,1)
  assert.equal((await f.query('notification.list')).filter(row=>row.id===crashId).length,1)
  assert.equal((await f.read()).state,'prepared','unrelated prepared notification is not sent by recovery')
})
