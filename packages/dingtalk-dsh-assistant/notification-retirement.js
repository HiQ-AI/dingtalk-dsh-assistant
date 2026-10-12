import {executionError} from './execution-artifacts.js'

// 此处理器不接收任何渠道适配器，预检只读；提交仅调用原控制账事务。
export function createNotificationRetirementHandler({store,artifacts,groups,webActorId}) {
  return async (input,identity,check=false)=>{
    if(identity?.channel!=='web'||!webActorId||identity.actorId!==webActorId)throw executionError('WORKFLOW_NOTIFICATION_FORBIDDEN')
    const notice=await store.query({kind:'message.notification',notificationId:input.notificationId})
    if(!notice||!groups.has(notice.payload?.conversationId))throw executionError('WORKFLOW_NOTIFICATION_FORBIDDEN')
    if(!check&&notice.status==='superseded'&&notice.retirement){
      const prior=notice.retirement
      if(prior.requestId!==input.requestId||prior.expectedFactDigest!==input.expectedFactDigest
        ||prior.supersededByNotificationId!==input.supersededByNotificationId||prior.actorId!==identity.actorId)throw executionError('MESSAGE_NOTIFICATION_RETIRE_CONFLICT')
      return {notification:notice,replayed:true}
    }
    const snapshot=await store.query({kind:'message.notificationRetirement',notificationId:input.notificationId,supersededByNotificationId:input.supersededByNotificationId})
    if(check)return snapshot
    if(typeof input.requestId!=='string'||!input.requestId.trim())throw executionError('MESSAGE_NOTIFICATION_RETIRE_REQUEST_REQUIRED')
    if(input.expectedFactDigest!==snapshot.expectedFactDigest)throw executionError('MESSAGE_NOTIFICATION_RETIRE_STALE')
    const evidence=await artifacts.put({kind:'notification-retirement-preflight',...snapshot})
    const receipt=await store.command({id:`notification-retirement:${input.requestId}`,kind:'message.notification.retire',args:{
      notificationId:input.notificationId,supersededByNotificationId:input.supersededByNotificationId,expectedFactDigest:input.expectedFactDigest,
      requestId:input.requestId,actorId:identity.actorId,authorizationRef:`host-web:${encodeURIComponent(identity.actorId)}`,evidenceRef:evidence.ref}})
    return {...receipt.result,replayed:receipt.replayed}
  }
}
