import {ObserverMemoryPages} from './observer-memory-pages.js'
export function createObserverAlertPages({failures,tasks,operations,notifications,groups=()=>[]}){
 const index=new ObserverMemoryPages(),firstSeen=new Map(),groupFailures=new WeakMap();let signature='',readers=new Map()
 const collect=()=>{
  const descriptors=[]
  const add=(id,stamp,read)=>{if(!firstSeen.has(id))firstSeen.set(id,new Date().toISOString());descriptors.push({id,stamp:stamp??firstSeen.get(id),read})}
  for(const group of groups()){
   if(!groupFailures.has(group))groupFailures.set(group,group.messages.find(message=>['failed','decision-failed','decision-commit-failed'].includes(message.agentDeliveryStatus))??null)
   const failed=groupFailures.get(group)
   if(failed)add(`coordination:${group.groupId}`,failed.agentDeliveryAt,()=>({alertId:`coordination:${group.groupId}`,fingerprint:`coordination:${group.groupId}`,detail:failed.agentDeliveryError??'群消息归类或协调失败，原消息尚未处理。',status:'active',lastSeenAt:failed.agentDeliveryAt??firstSeen.get(`coordination:${group.groupId}`)}))
  }
  for(const item of failures.values())add(`failure:${item.id}`,item.at,()=>({alertId:`failure:${item.id}`,taskId:tasks.has(item.id)?item.id:undefined,fingerprint:`task-session:${item.id}`,detail:item.code,status:'active',lastSeenAt:item.at??firstSeen.get(`failure:${item.id}`)}))
  for(const item of operations.values())if(item.state==='unknown')add(`operation:${item.id??item.operationId}`,item.updatedAt??item.createdAt,()=>({alertId:`operation:${item.id??item.operationId}`,taskId:item.taskId,fingerprint:`unknown-operation:${item.id??item.operationId}`,detail:'执行效果未知，已阻止后续操作；须核实原始效果。',status:'active',lastSeenAt:item.updatedAt??item.createdAt}))
  for(const item of notifications.values())if(item.state==='unknown')add(`notification:${item.id}`,item.updatedAt,()=>({alertId:`notification:${item.id}`,taskId:item.taskId,fingerprint:`unknown-notification:${item.id}`,detail:'群通知发送结果尚未回读确认。',status:'active',lastSeenAt:item.updatedAt}))
  for(const item of tasks.values())if(item.status==='active'&&(item.lastDecision?.action==='blocked'||item.lastDecision?.action==='wait'&&!!item.lastDecision?.question?.trim()))add(`task-blocked:${item.taskId}`,item.updatedAt,()=>({alertId:`task-blocked:${item.taskId}`,taskId:item.taskId,fingerprint:`task-blocked:${item.taskId}`,detail:item.lastDecision.summary,status:'active',lastSeenAt:item.updatedAt}))
  return descriptors
 }
 return {all:()=>collect().map(item=>item.read()),async page({offset=0,limit=10,view='active',type='all',revision}={}){
  const descriptors=collect(),next=JSON.stringify(descriptors.map(({id,stamp})=>[id,stamp]))
  readers=new Map(descriptors.map(item=>[item.id,item.read]))
  if(next!==signature||!index.collections.has('alerts')){signature=next;index.replace('alerts',next,descriptors.map(item=>({id:item.id,sort:item.stamp,filters:['active:all','active:runtime']})))}
  return index.page('alerts',{offset,limit,revision,filter:`${view}:${type}`},id=>readers.get(id)())
 }}
}
