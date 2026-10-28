import {topicMessages,topicMessageCount} from '../packages/dingtalk-dsh-assistant/topic-model.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createObserverGroupPages} from '../packages/dingtalk-dsh-assistant/observer-group-pages.js'
import {ObserverMemoryPages} from '../packages/dingtalk-dsh-assistant/observer-memory-pages.js'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {observerOutboxState} from '../packages/dingtalk-dsh-assistant/observer-outbox-state.js'

test('group paging resolves only page payloads; filters/count use cached metadata and stable IDs',async()=>{
 let metadataReads=0,version='1',group={groupId:'g',topics:[],outbox:[],messages:Array.from({length:1000},(_,i)=>({messageId:`m${i}`,messageVersion:1,sequence:i,occurredAt:'2026-10-28T00:00:00Z',routingStatus:i%2?'pending':'failed',text:'payload'}))}
 const reads=[]
 const page=createObserverGroupPages({readGroup:()=>group,readVersion:()=>version,readMetadata:()=>{metadataReads++;return {sources:[],coordinationSources:[]}},readSources:(_,ids)=>{reads.push(ids);return []},readRequests:()=>[],ownerships:()=>[],isOwnNotification:()=>false})
 const first=await page('g',{filter:'failed',limit:10})
 assert.equal(first.total,500);assert.equal(first.items.length,10);assert.equal(reads[0].length,10);assert.equal(first.items[0].messageId,'m998')
 const second=await page('g',{filter:'failed',offset:10,limit:10,revision:first.revision})
 assert.equal(metadataReads,1);assert.equal(reads[1].length,10);assert(!second.items.some(item=>first.items.some(prior=>prior.messageId===item.messageId)))
 version='2';await assert.rejects(page('g',{offset:10,limit:10,revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
 group={...group,messages:[]};assert.equal((await page('g',{})).total,0)
})
test('outbox selection does not read source tables or message projections',async()=>{
 const group={outbox:Array.from({length:125},(_,i)=>({outboundId:`o${i}`,notificationState:i%2?'prepared':'delivered'}))}
 const fail=()=>{throw new Error('unexpected source/history read')}
 const page=createObserverGroupPages({readGroup:()=>group,readVersion:fail,readMetadata:fail,readSources:fail,readRequests:fail,ownerships:fail,isOwnNotification:fail})
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


test('message pages do not inspect outbox history; evicted metadata rejects an old cursor',async()=>{
 const groups=new Map(Array.from({length:130},(_,i)=>[`g${i}`,{groupId:`g${i}`,topics:[],messages:[{messageId:'m',messageVersion:1,sequence:1,text:'Synthetic'}],get outbox(){throw new Error('message page inspected unrelated outbox history')}}]))
 const page=createObserverGroupPages({readGroup:id=>groups.get(id),readVersion:()=>1,readMetadata:()=>({sources:[],coordinationSources:[]}),readSources:()=>[],readRequests:()=>[],ownerships:()=>[],isOwnNotification:()=>false})
 const first=await page('g0',{limit:1})
 for(let i=1;i<130;i++)await page(`g${i}`,{limit:1})
 await assert.rejects(page('g0',{limit:1,revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
 assert.equal((await page('g0',{limit:1})).items.length,1)
})
