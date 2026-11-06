import {topicMessages,topicMessageCount} from '../packages/dingtalk-dsh-assistant/topic-model.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createObserverGroupPages} from '../packages/dingtalk-dsh-assistant/observer-group-pages.js'
import {ObserverMemoryPages} from '../packages/dingtalk-dsh-assistant/observer-memory-pages.js'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {runInNewContext} from 'node:vm'
import {observerOutboxState} from '../packages/dingtalk-dsh-assistant/observer-outbox-state.js'
import {stableId} from '../packages/dingtalk-dsh-assistant/topic-model.js'

test('group paging uses SQL rows without reading source or resident history; commits update affected IDs',async t=>{
 let group={groupId:'g',topics:[],outbox:[],messages:Array.from({length:1000},(_,i)=>({messageId:`m${i}`,messageVersion:1,sequence:i,occurredAt:'2026-10-28T00:00:00Z',routingStatus:i%2?'pending':'failed',text:'payload',get resources(){throw new Error('hidden payload read')}}))}
 const reads=[]
 const page=createObserverGroupPages({readGroup:()=>group,readSources:(_,ids)=>{reads.push(ids);return []},readRequests:()=>[],isOwnNotification:()=>false})
 t.after(()=>page.close());page.update({group});await page.ready()
 assert(reads.every(batch=>batch.length<=100));reads.length=0
 const prior=group
 group={...group,get messages(){throw new Error('page scanned messages')},get topics(){throw new Error('page scanned decisions')}}
 const first=await page('g',{filter:'failed',limit:10})
 assert.equal(first.total,500);assert.equal(first.items.length,10);assert.equal(reads.length,0);assert.equal(first.items[0].messageId,'m998')
 const second=await page('g',{filter:'failed',offset:10,limit:10,revision:first.revision})
 assert.equal(reads.length,0);assert(!second.items.some(item=>first.items.some(prior=>prior.messageId===item.messageId)))
 group={...prior,messages:prior.messages.map(message=>message.messageId==='m998'?{...messageInput(message),routingStatus:'pending'}:message)}
 function messageInput(message){return {messageId:message.messageId,messageVersion:1,sequence:message.sequence,occurredAt:message.occurredAt,text:message.text}}
 page.update({previous:prior,group});await page.ready()
 assert.deepEqual(reads,[[{messageId:'m998',version:1}]])
 await assert.rejects(page('g',{offset:10,limit:10,revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
 const empty={...group,messages:[]};page.update({previous:group,group:empty});group=empty
 assert.equal((await page('g',{})).total,0)
})
test('outbox selection does not read source tables or message projections',async t=>{
 const group={outbox:Array.from({length:125},(_,i)=>({outboundId:`o${i}`,notificationState:i%2?'prepared':'delivered'}))}
 const fail=()=>{throw new Error('unexpected source/history read')}
 const page=createObserverGroupPages({readGroup:()=>group,readVersion:fail,readMetadata:fail,readSources:fail,readRequests:fail,ownerships:fail,isOwnNotification:fail})
 t.after(()=>page.close())
 const result=await page('g',{collection:'outbox',filter:'confirmed',offset:10,limit:10})
 assert.equal(result.total,63);assert.equal(result.items.length,10);assert.equal(result.items[0].outboundId,'o104')
})
test('memory index selects before resolving bodies and rejects a source replacement during async page read',async()=>{
 const index=new ObserverMemoryPages(), rows=Array.from({length:10000},(_,i)=>({id:String(i),sort:String(i).padStart(8,'0'),filters:[i%2?'odd':'even']}))
 index.replace('list',{},rows);let reads=0
 assert.equal((await index.page('list',{filter:'odd',offset:300,limit:10},id=>{reads++;return id})).total,5000);assert.equal(reads,10)
 await assert.rejects(index.page('list',{limit:1},id=>{index.replace('list',{},[]);return id}),{code:'OBSERVER_PAGE_STALE'})
})
test('server outbox filter agrees with existing UI delivery semantics across historical/current combinations',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const start=source.indexOf('    const outboxDelivery ='),end=source.indexOf('    const ui =',start)
 const ui=runInNewContext(`${source.slice(start,end)};outboxDelivery`)
 for(const status of ['pending','sent','superseded'])for(const notificationState of [undefined,'prepared','starting','acknowledged','unknown','delivered','failed','superseded'])for(const reason of [undefined,'delivery_unknown','postflight_failed','task-notification-task-terminal','task-notification-confirmation-reassessment-required'])for(const known of [false,true]){
  const message={status,notificationState,deliveryPendingReason:reason,notificationKnownNotSent:known}
  assert.equal(observerOutboxState(message),ui(message).id,JSON.stringify(message))
 }
})


test('topic page builds only reference metadata before touching requested message text',()=>{
 let touched=new Set()
 const messages=Array.from({length:1000},(_,i)=>({messageId:`m${i}`,messageVersion:1,sequence:i,get text(){assert(i>=510&&i<520,'unselected message body was read');touched.add(i);return `Synthetic ${i}`}}))
 const topic={revision:1,entries:messages.map(message=>({messageId:message.messageId,messageVersion:1,revision:1,action:'add'}))}
 const group={messages}
 assert.equal(topicMessageCount(group,topic,1),1000);assert.equal(touched.size,0)
 const page=topicMessages(group,topic,1,{offset:510,limit:10})
 assert.equal(page.length,10);assert.equal(touched.size,10);assert.equal(page[0].messageId,'m510')
})


test('persistent inbox survives restart; source completion updates its row without touching outbox history',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'inbox-index-'));let page
 t.after(async()=>{await page?.close();await rm(dir,{recursive:true,force:true})})
 const group={groupId:'g',topics:[],messages:[{messageId:'m',messageVersion:1,sequence:1,routingStatus:'routed',activeUnitRefs:[],text:'Synthetic'}],get outbox(){throw new Error('message page inspected unrelated outbox history')}}
 let sources=[],reads=0
 const options={indexPath:join(dir,'inbox.sqlite'),readGroup:()=>group,readSources:()=>{reads++;return sources},readRequests:()=>[],isOwnNotification:()=>false}
 page=createObserverGroupPages(options);page.update({group})
 const first=await page('g',{limit:1});await page.close()
 page=createObserverGroupPages(options)
 const resumed=await page('g',{limit:1,revision:first.revision});assert.deepEqual(resumed,first);assert.equal(reads,1)
 page.update({group});await page.ready()
 assert.equal((await page('g',{limit:1})).revision,first.revision,'unchanged startup preserves revision')
 sources=[{sourceId:'s',groupId:'g',messageId:'m',version:1,routed:true,processingCompleted:{at:'2026-10-29T00:00:00Z',activeUnitRefs:[]}}]
 page.sourceChanged(sources[0])
 const done=await page('g',{filter:'processed'});assert.equal(done.total,1);assert.equal(reads,3)
 assert.equal(done.items[0].processingCompletedAt,new Date(sources[0].processingCompleted.at).toISOString())
 await assert.rejects(page('g',{revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
})

test('direct source projection links exact version and ignores Topic completion state',async t=>{
 const message={messageId:'m',messageVersion:2,sequence:1,occurredAt:'2026-11-06T00:00:00.000Z',routingStatus:'routed',text:'直接来源'}
 let source={sourceId:'source-m-v2',groupId:'g',messageId:'m',version:2,processingPending:true}
 let group={groupId:'g',topics:[{topicId:'old',revision:1,processedRevision:1,entries:[{messageId:'m',messageVersion:2,action:'add'}],decisions:[{status:'completed',completedAt:'2026-11-06T00:01:00.000Z'}]}],messages:[message],router:{queue:[{kind:'source',id:source.sourceId,sourceRef:{sourceId:source.sourceId,messageId:'m',messageVersion:2}}],active:null}}
 const page=createObserverGroupPages({readGroup:()=>group,readSources:()=>[source],readRequests:()=>[],isOwnNotification:()=>false})
 t.after(()=>page.close());page.update({group});await page.ready()
 let row=(await page('g')).items[0]
 assert.equal(row.processingState,'processing','old Topic completion is not a direct source terminal')
 assert.deepEqual(row.sourceRefs,[{sourceId:'source-m-v2',messageId:'m',version:2}])
 assert.equal(row.topicRefs,undefined)
 const previous=group
 source={...source,processingPending:false,directProcessing:{disposition:{phase:'router',decisionId:'decision-1'},at:'2026-11-06T00:02:00.000Z'},processingCompleted:{mode:'direct',decisionId:'decision-1',at:'2026-11-06T00:02:00.000Z'}}
 group={...group,router:{queue:[],active:null}}
 page.update({previous,group});page.sourceChanged(source);await page.ready()
 row=(await page('g',{filter:'processed'})).items[0]
 assert.equal(row.processingState,'processed')
 assert.equal(row.processingCompletedAt,new Date(source.directProcessing.at).toISOString())
})

test('another source update cannot hide an interrupted projection',async t=>{
 let group={groupId:'g',topics:[],messages:['a','b'].map(messageId=>({messageId,messageVersion:1,text:'Original'}))},unavailable=false
 const page=createObserverGroupPages({readGroup:()=>group,readSources:()=>{if(unavailable)throw new Error('source unavailable');return []},readRequests:()=>[],isOwnNotification:()=>false})
 t.after(()=>page.close());page.update({group});await page.ready()
 const previous=group;group={...group,messages:group.messages.map(message=>message.messageId==='a'?{...message,text:'Updated'}:message)}
 unavailable=true;page.update({previous,group})
 await assert.rejects(page('g'),/source unavailable/)
 unavailable=false;page.sourceChanged({groupId:'g',messageId:'b'})
 assert.equal((await page('g')).items.find(message=>message.messageId==='a').text,'Updated')
})

test('a Web-only completion cannot cover an earlier group message or hide its later conclusion',async t=>{
 const ref={unitId:'group-unit',unitRevision:1},webRef={unitId:'web-unit',unitRevision:1}
 const message={messageId:'group-input',messageVersion:2,sequence:1,routingStatus:'routed',activeUnitRefs:[ref],units:[ref],text:'补充空状态验收要求'}
 const webId=stableId('web','g:followup')
 const web={decisionId:stableId('decision','g:followup'),revision:3,status:'completed',completedAt:'2026-01-01T00:01:00Z',decision:{actions:[],basisMessageIds:[webId],basisUnitRefs:[webRef],reply:''}}
 let group={groupId:'g',messages:[message],topics:[{topicId:'t',revision:3,processedRevision:3,
  entries:[{revision:2,messageId:message.messageId,messageVersion:2,...ref,action:'add'}],decisions:[web]}]}
 const source={sourceId:'s',groupId:'g',messageId:message.messageId,version:2,routed:true,processingCompleted:{at:web.completedAt,activeUnitRefs:[ref]}}
 const page=createObserverGroupPages({readGroup:()=>group,readSources:()=>[source],readRequests:()=>[],isOwnNotification:()=>false})
 t.after(()=>page.close());page.update({group})
 let row=(await page('g')).items[0]
 assert.equal(row.processingState,'processing','an old premature source stamp is not sufficient evidence')
 assert.equal(row.processingConclusion,null)
 assert.equal(row.processingCompletedAt,null)
 const previous=group
 const actual={decisionId:'coord-decision-current',revision:3,status:'completed',completedAt:'2026-01-01T00:02:00Z',
  decision:{actions:[],basisMessageIds:[message.messageId],basisUnitRefs:[ref],reason:'已核对空状态验收要求'}}
 group={...group,topics:[{...group.topics[0],decisions:[web,actual]}]}
 source.processingCompleted={...source.processingCompleted,at:actual.completedAt}
 page.update({previous,group})
 row=(await page('g')).items[0]
 assert.equal(row.processingState,'processed')
 assert.equal(row.processingConclusion,actual.decision.reason,'select the real Topic judgment at the same revision')
 assert.equal(row.processingCompletedAt,new Date(actual.completedAt).toISOString())
})

test('router failure requests project on cold sync and incremental state changes without hiding completed source identity',async t=>{
 const message={messageId:'m',messageVersion:2,sequence:1,occurredAt:'2026-11-06T00:00:00.000Z',routingStatus:'routed',text:'来源已完成，后续回复失败'}
 const source={sourceId:'source-m-v2',groupId:'g',messageId:'m',version:2,routed:true,
  directProcessing:{disposition:{phase:'router',decisionId:'decision-1'},at:'2026-11-06T00:02:00.000Z'},
  processingCompleted:{mode:'direct',decisionId:'decision-1',at:'2026-11-06T00:02:00.000Z'}}
 const failure={sourceRef:{sourceId:source.sourceId,messageId:'m',messageVersion:2},phase:'host',requestId:'reply-host-1',status:'failed',attempt:1,
  routingEpoch:4,code:'HOST_REPLY_FAILED',failurePhase:'application',retryToken:'retry-token-1'}
 let failures=[failure,
  {...failure,sourceRef:{...failure.sourceRef,sourceId:'another-source'},requestId:'wrong-source'},
  {...failure,sourceRef:{...failure.sourceRef,messageVersion:1},requestId:'old-version'}]
 let group={groupId:'g',topics:[],messages:[message],router:{failures}}
 const page=createObserverGroupPages({readGroup:()=>group,readSources:()=>[source],readRequests:()=>failures,isOwnNotification:()=>false})
 t.after(()=>page.close());page.update({group});await page.ready()
 let row=(await page('g',{filter:'processed'})).items[0]
 assert.equal(row.processingState,'processed','the source completion remains the semantic result')
 assert.deepEqual(row.processingRecovery,{sourceId:'source-m-v2',messageId:'m',messageVersion:2,phase:'host',role:'application',requestId:'reply-host-1',retryToken:'retry-token-1'})
 const previous=group
 const retrying={...failure,status:'retrying',retryToken:undefined,attempt:2}
 failures=[retrying,...failures.slice(1)]
 group={...group,router:{failures}}
 page.update({previous,group});await page.ready()
 row=(await page('g',{filter:'processed'})).items[0]
 assert.equal(row.processingState,'processed')
 assert.equal(row.processingRecovery,null,'an in-flight retry has no retry affordance')
 assert.equal(row.processingRetrying,true,'attempted is not a terminal result')
})

test('message recovery UI sends the persisted request identity and displays Router role',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const start=source.indexOf('    function messageRecoveryDetails('),end=source.indexOf('    function MessageRecovery(',start)
 assert.ok(start>=0&&end>start)
 const helper=runInNewContext(`${source.slice(start,end)}; messageRecoveryDetails`)
 const direct=JSON.parse(JSON.stringify(helper({messageId:'m',messageVersion:3,activeUnitRefs:[]},{sourceId:'source-m-v2',messageId:'m',messageVersion:2,
  phase:'host',role:'application',requestId:'reply-host-1',retryToken:'retry-token-1'})))
 assert.deepEqual(direct.body,{messageVersion:2,activeUnitRefs:[],phase:'host',requestId:'reply-host-1',token:'retry-token-1'})
 assert.match(direct.identity,/应用处理（host）/)
 assert.match(direct.identity,/source-m-v2/)
 assert.match(direct.identity,/消息 m v2/)
 assert.match(direct.identity,/请求 reply-host-1/)
 const legacy=JSON.parse(JSON.stringify(helper({messageId:'old',messageVersion:7,activeUnitRefs:[{unitId:'u',unitRevision:1}]},
  {messageId:'old',phase:'decision',requestId:'legacy-request',token:'legacy-token'})))
 assert.deepEqual(legacy.body,{messageVersion:7,activeUnitRefs:[{unitId:'u',unitRevision:1}],phase:'decision',requestId:'legacy-request',token:'legacy-token'})
})
