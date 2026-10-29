import {ObserverMemoryPages} from './observer-memory-pages.js'
import {messageProcessingProjection} from './observer-message-projection.js'
import {observerOutboxState} from './observer-outbox-state.js'

// The resident domain already owns message payloads in memory. This observer index
// retains IDs/memberships only; it never creates another all-history payload array.
export function createObserverGroupPages({readGroup,readVersion,readMetadata,readSources,readRequests,isOwnNotification,ownerships}) {
 const pages=new ObserverMemoryPages(), caches=new Map()
 const remember=(key,value)=>{caches.delete(key);caches.set(key,value);if(caches.size>128){const oldest=caches.keys().next().value;caches.delete(oldest);pages.collections.delete(oldest)}}
 return async (groupId,{collection='messages',offset=0,limit=10,filter='all',revision}={})=>{
  if(!['messages','outbox'].includes(collection))throw new Error('OBSERVER_PAGE_INVALID')
  const group=readGroup(groupId)
  if(!group)return null
  if(collection==='outbox'){
   const key=`${groupId}:outbox`,prior=caches.get(key)
   let cache=prior
   if(!prior||prior.source!==group.outbox){const byId=new Map(group.outbox.map(message=>[message.outboundId,message]));cache={source:group.outbox,byId};remember(key,cache);pages.replace(key,cache,group.outbox.map((message,index)=>({id:message.outboundId,sort:String(index).padStart(17,'0'),filters:[observerOutboxState(message)]})))}
   return pages.page(key,{offset,limit,filter,revision},id=>cache.byId.get(id))
  }
  const version=await readVersion(groupId)
  const messageKey=`${groupId}:messages`
  let cache=caches.get(messageKey)
  if(cache&&(cache.group!==group||cache.version!==version)&&revision)throw Object.assign(new Error('OBSERVER_PAGE_STALE'),{code:'OBSERVER_PAGE_STALE'})
  if(!cache||cache.group!==group||cache.version!==version){
   const rawMessages=new Map(group.messages.map(message=>[message.messageId,message]))
   const requests=readRequests(groupId), topicsByMessage=new Map(), requestsByMessage=new Map()
   for(const topic of group.topics.filter(topic=>!topic.mergedInto)){
    const byMessage=new Map()
    for(const entry of topic.entries){if(!byMessage.has(entry.messageId))byMessage.set(entry.messageId,[]);byMessage.get(entry.messageId).push(entry)}
    for(const [messageId,entries] of byMessage){if(!topicsByMessage.has(messageId))topicsByMessage.set(messageId,[]);topicsByMessage.get(messageId).push({...topic,entries})}
   }
   for(const request of requests)for(const ref of request.messages){if(!requestsByMessage.has(ref.messageId))requestsByMessage.set(ref.messageId,[]);requestsByMessage.get(ref.messageId).push(request)}
   const metadata=await readMetadata(groupId), sourceMap=new Map(), coordinationBySource=new Map(), ownersByKey=new Map()
   const ownerKey=(reservation,generation,unit,revision,message,version)=>JSON.stringify([reservation,generation,unit,revision,message,version])
   for(const owner of ownerships(groupId))if(owner.dispatchOwner==='coordination'){
    const key=ownerKey(owner.reservationId,owner.generation,owner.unitId,owner.unitRevision,owner.sourceSnapshot?.messageId,owner.sourceSnapshot?.messageVersion)
    if(!ownersByKey.has(key))ownersByKey.set(key,owner)
   }
   for(const item of metadata.coordinationSources)if(item.dispatchOwner==='coordination')for(const ref of new Set(item.sourceRefs??[])){
    const key=JSON.stringify([item.sourceMessageId,ref]);if(!coordinationBySource.has(key))coordinationBySource.set(key,[])
    coordinationBySource.get(key).push(item)
   }
   for(const source of metadata.sources){
    const matches=coordinationBySource.get(JSON.stringify([source.messageId,source.sourceId]))??[]
    const coordination=matches.flatMap(item=>{
     const owner=ownersByKey.get(ownerKey(item.reservationId,item.reservationGeneration,item.unitId,item.revision,source.messageId,source.version))
     return owner?[{unitId:item.unitId,unitRevision:item.revision,state:item.state,attempt:item.attemptCount??0,nextRetryAt:item.nextRetryAt,
      semanticState:item.resolvedBy?'accepted':item.state==='needs_clarification'||item.pendingClarifications?.length?'needs_clarification':item.state,
      resolved:!!item.resolvedBy||['accepted','needs_clarification'].includes(owner.semanticState),frozen:!!item.frozen||owner.frozen===true}]:[]
    })
    const key=JSON.stringify([source.messageId,source.version]);if(!sourceMap.has(key))sourceMap.set(key,[]);sourceMap.get(key).push({...source,coordination})
   }
   const sourceFor=message=>{const found=sourceMap.get(JSON.stringify([message.messageId,message.messageVersion]))||[];return found.length===1?found[0]:undefined}
   const rows=[]
   for(const message of group.messages){
    if(![undefined,'dingtalk','migration','workflow-v2','task-session'].includes(message.sourceKind)||isOwnNotification({...message,groupId}))continue
    const state=messageProcessingProjection(message,topicsByMessage.get(message.messageId)||[],sourceFor(message),requestsByMessage.get(message.messageId)||[],true).processingState
    // Numeric timestamp and sequence are fixed-width sortable metadata.
    rows.push({id:message.messageId,sort:`${String(Date.parse(message.occurredAt)||0).padStart(17,'0')}:${String(message.sequence||0).padStart(17,'0')}`,filters:[state]})
   }
   cache={group,version,rawMessages,topicsByMessage,requestsByMessage}
   remember(messageKey,cache)
   pages.replace(`${groupId}:messages`,cache,rows)
  }
  let selectedSources
  const result=await pages.page(`${groupId}:${collection}`,{offset,limit,filter,revision},id=>id)
  selectedSources=await readSources(groupId,result.items.map(id=>({messageId:id,version:cache.rawMessages.get(id).messageVersion})))
  const byId=new Map()
  for(const source of selectedSources){const key=JSON.stringify([source.messageId,source.version]);if(!byId.has(key))byId.set(key,[]);byId.get(key).push(source)}
  if(await readVersion(groupId)!==version||readGroup(groupId)!==group)throw Object.assign(new Error('OBSERVER_PAGE_STALE'),{code:'OBSERVER_PAGE_STALE'})
  return {...result,routingRevision:group.routingRevision,items:result.items.map(id=>{
   const message=cache.rawMessages.get(id), topics=cache.topicsByMessage.get(id)||[], sources=byId.get(JSON.stringify([id,message.messageVersion]))||[]
   return {...message,...messageProcessingProjection(message,topics,sources.length===1?sources[0]:undefined,cache.requestsByMessage.get(id)||[]),
    topicRefs:topics.flatMap(topic=>{const latest=new Map(topic.entries.map(entry=>[entry.unitId??`legacy:${id}`,entry]));return [...latest.values()].filter(entry=>entry.action==='add'&&entry.messageVersion===message.messageVersion).map(entry=>({topicId:topic.topicId,revision:topic.revision,title:topic.title,unitId:entry.unitId,unitRevision:entry.unitRevision}))})}
  })}
 }
}
