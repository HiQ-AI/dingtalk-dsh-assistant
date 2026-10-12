import {pathToFileURL} from 'node:url'

// 单条、默认GET预检。没有派发、补发、撤回、维护切换或数据库入口。
export async function retireOne(input,request=fetch){
 const allowed=['notificationId','supersededByNotificationId','requestId','expectedFactDigest','apply']
 if(!input||Object.keys(input).some(k=>!allowed.includes(k))||['notificationId','supersededByNotificationId'].some(k=>typeof input[k]!=='string'||!input[k].trim()))throw Error('RETIRE_SINGLE_NOTICE_REQUIRED')
 if(input.apply!==undefined&&typeof input.apply!=='boolean')throw Error('RETIRE_APPLY_FLAG_INVALID')
 const path='http://127.0.0.1:18998/workflows/notifications/'+encodeURIComponent(input.notificationId)+'/retirement'
 const read=await request(path+'?supersededByNotificationId='+encodeURIComponent(input.supersededByNotificationId))
 const snapshot=await read.json();if(!read.ok)throw Error(snapshot.error??'RETIRE_PREFLIGHT_FAILED')
 if(!input.apply)return snapshot
 if(typeof input.requestId!=='string'||!input.requestId.trim()||!/^[a-f0-9]{64}$/u.test(input.expectedFactDigest??''))throw Error('RETIRE_REVIEWED_DIGEST_REQUIRED')
 if(snapshot.expectedFactDigest!==input.expectedFactDigest)throw Error('RETIRE_PREFLIGHT_CHANGED')
 const response=await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
  requestId:input.requestId,supersededByNotificationId:input.supersededByNotificationId,expectedFactDigest:input.expectedFactDigest})})
 const result=await response.json();if(!response.ok)throw Error(result.error??'RETIRE_FAILED');return result
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [notificationId,supersededByNotificationId,...args]=process.argv.slice(2)
 const apply=args[0]==='--apply'
 if(args.length&&(!apply||args.length!==3))throw Error('Usage: node scripts/retire-outbox-notification.mjs <noticeId> <replacementId> [--apply <requestId> <reviewedDigest>]')
 const value=await retireOne({notificationId,supersededByNotificationId,apply,...(apply?{requestId:args[1],expectedFactDigest:args[2]}:{})})
 console.log(JSON.stringify(apply?{notificationId:value.notification.id,status:value.notification.status,retirement:value.notification.retirement,replayed:value.replayed}
  :{notificationId:value.notificationId,supersededByNotificationId:value.supersededByNotificationId,taskId:value.taskId,reason:value.reason,expectedFactDigest:value.expectedFactDigest,replacementMessageId:value.replacementMessageId},null,2))
}
