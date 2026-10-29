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
 const dir=await mkdtemp(join(tmpdir(),'inbox-index-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const group={groupId:'g',topics:[],messages:[{messageId:'m',messageVersion:1,sequence:1,routingStatus:'routed',activeUnitRefs:[],text:'Synthetic'}],get outbox(){throw new Error('message page inspected unrelated outbox history')}}
 let sources=[],reads=0
 const options={indexPath:join(dir,'inbox.sqlite'),readGroup:()=>group,readSources:()=>{reads++;return sources},readRequests:()=>[],isOwnNotification:()=>false}
 let page=createObserverGroupPages(options);page.update({group})
 const first=await page('g',{limit:1});await page.close()
 page=createObserverGroupPages(options);t.after(()=>page.close())
 const resumed=await page('g',{limit:1,revision:first.revision});assert.deepEqual(resumed,first);assert.equal(reads,1)
 page.update({group});await page.ready()
 assert.equal((await page('g',{limit:1})).revision,first.revision,'unchanged startup preserves revision')
 sources=[{sourceId:'s',groupId:'g',messageId:'m',version:1,routed:true,processingCompleted:{at:'2026-10-29T00:00:00Z',activeUnitRefs:[]}}]
 page.sourceChanged(sources[0])
 const done=await page('g',{filter:'processed'});assert.equal(done.total,1);assert.equal(reads,3)
 assert.equal(done.items[0].processingCompletedAt,new Date(sources[0].processingCompleted.at).toISOString())
 await assert.rejects(page('g',{revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
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
