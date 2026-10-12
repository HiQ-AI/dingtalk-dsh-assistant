import test from 'node:test'
import assert from 'node:assert/strict'
import {classifyOutboxNotification as classify} from '../packages/dingtalk-dsh-assistant/outbox-audit-classification.js'
function fixture(phase='receipt'){
 const n={outboundId:'old',runId:'query',groupId:'g',phase,status:'pending',createdAt:'2026-01-01T00:00:00Z'}
 const kept={outboundId:'final',runId:'done',groupId:'g',phase:'owner:latest',status:'sent',deliveredMessageId:'m',text:'当前完整结论\n\n- 代回',createdAt:'2026-01-02T00:00:00Z'}
 const task={taskId:'t',state:'completed',inputVersion:2,taskRunId:'current',result:'当前完整结论',taskOwner:{decision:'complete',status:'idle',requirementRevision:1,eventWatermark:3,processedWatermark:3}}
 const action={status:'applied',kind:'status',result:{taskId:'t',runId:'current'}}
 const context={rows:[n,kept],tasks:[task],sources:new Map([['query',{commands:[action]}],['done',{commands:[{result:{taskId:'t'}}]}]])}
 return{n,kept,task,action,context}
}
test('completed task queried at its current Run is never obsolete just because it completed',()=>{
 const f=fixture();assert.equal(classify(f.n,f.context).category,'undetermined')
 f.action.result.runId='older';assert.equal(classify(f.n,f.context).category,'obsolete')
})
test('old query must have exact older Run and current delivered replacement evidence',()=>{
 const f=fixture();f.action.result.runId='older';const result=classify(f.n,f.context)
 assert.equal(result.supersededByNotificationId,'final');assert.equal(result.replacementMessageId,'m')
 for(const patch of [{status:'pending'},{deliveredMessageId:null},{groupId:'other'},{text:'另外的结果'},{createdAt:'2025-01-01T00:00:00Z'}]){
  const kept={...f.kept,...patch};assert.equal(classify(f.n,{...f.context,rows:[f.n,kept]}).category,'undetermined')
 }
 f.context.sources.get('query').commands.push({...f.action,result:{taskId:'t',runId:'current'}})
 assert.equal(classify(f.n,f.context).category,'undetermined')
})
test('late start and older Owner report need the current independently delivered conclusion',()=>{
 for(const phase of ['task:started','owner:old']){
  const f=fixture(phase);f.action.kind='create'
  assert.equal(classify(f.n,f.context).category,'obsolete')
  f.task.taskOwner.processedWatermark=2;assert.equal(classify(f.n,f.context).category,'undetermined')
 }
})
test('public completed projection with stale requirement-plan binding cannot authorize old Owner notification retirement',()=>{
 const f=fixture('owner:old');f.task.plan={requirementCurrent:false}
 assert.equal(classify(f.n,f.context).category,'undetermined')
})
test('prepared lease-zero automatic start is obsolete by withdrawn policy, without assuming native task completion',()=>{
 const f=fixture('task:started');f.action.kind='create';f.task.state='pending';f.task.plan={requirementCurrent:false}
 f.n.notificationStatus='prepared';f.n.deliveryAttemptCount=0
 const result=classify(f.n,f.context);assert.equal(result.category,'obsolete');assert.equal(result.reason,'automatic-start-policy-withdrawn')
 f.n.notificationStatus='unknown';assert.equal(classify(f.n,f.context).category,'undetermined')
})
