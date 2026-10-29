import {ObserverMemoryPages} from './observer-memory-pages.js'
import {messageProcessingProjection} from './observer-message-projection.js'
import {observerOutboxState} from './observer-outbox-state.js'
import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {retiredSourceOwnership} from './coordination-retirement.js'

const fields=['messageId','messageVersion','sequence','senderName','senderOpenDingTalkId','occurredAt','text','runId','activeUnitRefs','taskSessionRefs','workflowStatusDetail','agentDeliveryError','waiting','blockingSources','notifications']
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))
const messageInput=message=>pick(message,[...fields,'sourceKind','routingStatus','ignoredRanges','agentDeliveryStatus','agentDeliveryAt','units','messageAiSendFlag','quotedMessage','actorId'])
const fail=code=>{throw Object.assign(new Error(code),{code})}

// Derived, persistent list rows. Startup reconciles resident records once (including
// an interrupted projection); committed changes update affected IDs. GET never
// builds an index or reads source/decision/history records before or after LIMIT.
export function createObserverGroupPages({readGroup,readSources,readRequests,isOwnNotification,readTask,indexPath=':memory:'}) {
 const pages=new ObserverMemoryPages(), outboxes=new Map(), failures=new Map()
 const index=new DatabaseSync(indexPath)
 try {
  index.exec('CREATE TABLE IF NOT EXISTS inbox (group_id TEXT, id TEXT, sort TEXT, state TEXT, body TEXT NOT NULL, PRIMARY KEY(group_id,id)); CREATE INDEX IF NOT EXISTS inbox_order ON inbox(group_id,sort DESC,id); CREATE INDEX IF NOT EXISTS inbox_state ON inbox(group_id,state,sort DESC,id); CREATE TABLE IF NOT EXISTS inbox_versions(group_id TEXT PRIMARY KEY,revision TEXT NOT NULL)')
 }catch(error){index.close();throw error}
 const revisionOf=groupId=>index.prepare('SELECT revision FROM inbox_versions WHERE group_id=?').get(groupId)?.revision
 let tail=Promise.resolve()
 const enqueue=(groupId,run)=>{
  tail=tail.then(run).then(()=>failures.delete(groupId),error=>{failures.set(groupId,error)})
 }
 const flush=async()=>{let pending;do {pending=tail;await pending}while(pending!==tail)}

 async function sync(group,ids) {
  const raw=new Map(group.messages.filter(message=>ids.has(message.messageId)).map(message=>[message.messageId,message]))
  const topicsByMessage=new Map(), requestsByMessage=new Map(), sourcesByMessage=new Map()
  for(const topic of group.topics.filter(topic=>!topic.mergedInto)){
   const entriesByMessage=new Map()
   for(const entry of topic.entries)if(ids.has(entry.messageId)){
    if(!entriesByMessage.has(entry.messageId))entriesByMessage.set(entry.messageId,[])
    entriesByMessage.get(entry.messageId).push(entry)
   }
   for(const [id,entries] of entriesByMessage){
    if(!topicsByMessage.has(id))topicsByMessage.set(id,[])
    topicsByMessage.get(id).push({...topic,entries})
   }
  }
  for(const request of readRequests(group.groupId))for(const ref of request.messages)if(ids.has(ref.messageId)){
   if(!requestsByMessage.has(ref.messageId))requestsByMessage.set(ref.messageId,[])
   requestsByMessage.get(ref.messageId).push(request)
  }
  const messages=[...raw.values()]
  for(let offset=0;offset<messages.length;offset+=100){
   const refs=messages.slice(offset,offset+100).map(message=>({messageId:message.messageId,version:message.messageVersion}))
   const selected=new Set(refs.map(ref=>ref.messageId))
   const sources=retiredSourceOwnership(await readSources(group.groupId,refs),(group.sourceDispatchOwnership??[]).filter(owner=>selected.has(owner.sourceSnapshot?.messageId)),group.groupId)
   for(const source of sources){
    const key=JSON.stringify([source.messageId,source.version])
    if(!sourcesByMessage.has(key))sourcesByMessage.set(key,[])
    sourcesByMessage.get(key).push(source)
   }
  }
  index.exec('BEGIN')
  try {
   const upsert=index.prepare('INSERT INTO inbox VALUES (?,?,?,?,?) ON CONFLICT(group_id,id) DO UPDATE SET sort=excluded.sort,state=excluded.state,body=excluded.body WHERE sort<>excluded.sort OR state<>excluded.state OR body<>excluded.body')
   const remove=index.prepare('DELETE FROM inbox WHERE group_id=? AND id=?')
   let changed=false
   for(const id of ids){
    const message=raw.get(id)
    if(!message||![undefined,'dingtalk','migration','workflow-v2','task-session'].includes(message.sourceKind)||isOwnNotification(Object.assign(Object.create(message),{groupId:group.groupId}))){
     changed=!!remove.run(group.groupId,id).changes||changed
     continue
    }
    const topics=topicsByMessage.get(id)||[], sources=sourcesByMessage.get(JSON.stringify([id,message.messageVersion]))||[]
    const source=sources.length===1?sources[0]:undefined
    const body={...pick(message,fields),...messageProcessingProjection(message,topics,source,requestsByMessage.get(id)||[],false,false),
     topicRefs:topics.flatMap(topic=>{
      const latest=new Map(topic.entries.map(entry=>[entry.unitId??'legacy',entry]))
      return [...latest.values()].filter(entry=>entry.action==='add'&&entry.messageVersion===message.messageVersion).map(entry=>({topicId:topic.topicId,revision:topic.revision,title:topic.title,unitId:entry.unitId,unitRevision:entry.unitRevision}))
     })}
    const sort=String(Date.parse(message.occurredAt)||0).padStart(17,'0')+':'+String(message.sequence||0).padStart(17,'0')
    changed=!!upsert.run(group.groupId,id,sort,body.processingState,JSON.stringify(body)).changes||changed
   }
   if(changed||!revisionOf(group.groupId))index.prepare('INSERT OR REPLACE INTO inbox_versions VALUES (?,?)').run(group.groupId,randomUUID())
   index.exec('COMMIT')
  }catch(error){index.exec('ROLLBACK');throw error}
 }

 const changed=(before,after,key,visit,project=value=>value)=>{
  const prior=new Map((before??[]).map(value=>[key(value),value]))
  for(const value of after??[]){
   const old=prior.get(key(value))
   if(old!==value&&(!old||!isDeepStrictEqual(project(old),project(value)))){if(old)visit(old);visit(value)}
   prior.delete(key(value))
  }
  for(const value of prior.values())visit(value)
 }
 const update=({previous,group,next=group,removed})=>{
  if(removed){enqueue(removed,()=>{index.prepare('DELETE FROM inbox WHERE group_id=?').run(removed);index.prepare('DELETE FROM inbox_versions WHERE group_id=?').run(removed);outboxes.delete(removed);pages.collections.delete(removed+':outbox')});return}
  enqueue(group.groupId,async()=>{
   const ids=new Set(), add=value=>{if(value?.messageId)ids.add(value.messageId)}
   if(!previous||failures.has(group.groupId)){
    for(const message of group.messages)add(message)
    for(const row of index.prepare('SELECT id FROM inbox WHERE group_id=?').all(group.groupId))ids.add(row.id)
   }else{
    changed(previous.messages,next.messages,value=>value.messageId,add,messageInput)
    changed(previous.topics,next.topics,value=>value.topicId,topic=>{for(const entry of topic.entries)add(entry)})
    changed(previous.sourceDispatchOwnership,next.sourceDispatchOwnership,value=>JSON.stringify([value.unitId,value.unitRevision]),owner=>add(owner.sourceSnapshot))
    // Topic Route/Decision request retry state is persisted in this legacy-named map.
    for(const id of new Set([...Object.keys(previous.coordinationRequests??{}),...Object.keys(next.coordinationRequests??{})]))
     if(!isDeepStrictEqual(previous.coordinationRequests?.[id],next.coordinationRequests?.[id])){
      add(previous.coordinationRequests?.[id]);add(next.coordinationRequests?.[id])
      for(const request of readRequests(group.groupId).filter(request=>request.requestId===id))for(const ref of request.messages)add(ref)
     }
   }
   await sync(group,ids)
  })
 }
 const page=async(groupId,{collection='messages',offset=0,limit=10,filter='all',revision}={})=>{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!['messages','outbox'].includes(collection))fail('OBSERVER_PAGE_INVALID')
  const group=readGroup(groupId)
  if(!group)return null
  if(collection==='outbox'){
   const key=groupId+':outbox'
   let cache=outboxes.get(groupId)
   if(!cache||cache.source!==group.outbox){
    cache={source:group.outbox,byId:new Map(group.outbox.map(message=>[message.outboundId,message]))}
    outboxes.set(groupId,cache)
    pages.replace(key,cache,group.outbox.map((message,i)=>({id:message.outboundId,sort:String(i).padStart(17,'0'),filters:[observerOutboxState(message)]})))
    if(outboxes.size>128){const oldest=outboxes.keys().next().value;outboxes.delete(oldest);pages.collections.delete(oldest+':outbox')}
   }
   return pages.page(key,{offset,limit,filter,revision},id=>cache.byId.get(id))
  }
  await flush()
  if(failures.has(groupId))throw failures.get(groupId)
  const current=revisionOf(groupId)
  if(!current)fail('OBSERVER_INBOX_NOT_READY')
  if(revision&&revision!==current)fail('OBSERVER_PAGE_STALE')
  const where=filter==='all'?'group_id=?':'group_id=? AND state=?',args=filter==='all'?[groupId]:[groupId,filter]
  const total=index.prepare('SELECT count(*) AS n FROM inbox WHERE '+where).get(...args).n
  const items=index.prepare('SELECT body FROM inbox WHERE '+where+' ORDER BY sort DESC,id LIMIT ? OFFSET ?').all(...args,limit,offset).map(row=>{
   const message=JSON.parse(row.body)
   return {...message,taskTitles:Object.fromEntries((message.taskSessionRefs??[]).map(id=>[id,readTask?.(id)?.title??id]))}
  })
  return {items,total,offset,limit,revision:current,routingRevision:readGroup(groupId)?.routingRevision,nextOffset:offset+items.length<total?offset+items.length:null}
 }
 page.update=update
 page.sourceChanged=source=>{
  if(!source?.groupId||!source.messageId)return
  enqueue(source.groupId,async()=>{
   const group=readGroup(source.groupId)
   if(!group)return
   // A successful update of B must not hide a failed projection of A.
   const ids=failures.has(source.groupId)
    ? new Set([...group.messages.map(message=>message.messageId),...index.prepare('SELECT id FROM inbox WHERE group_id=?').all(source.groupId).map(row=>row.id)])
    : new Set([source.messageId])
   await sync(group,ids)
  })
 }
 page.ready=async()=>{await flush();if(failures.size)throw failures.values().next().value}
 page.close=async()=>{await flush();index.close()}
 return page
}
