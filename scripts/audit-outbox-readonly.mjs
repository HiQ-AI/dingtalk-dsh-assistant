import {classifyOutboxNotification} from '../packages/dingtalk-dsh-assistant/outbox-audit-classification.js'
import {writeFile,mkdir} from 'node:fs/promises'
const origin='http://127.0.0.1:18998'
async function get(path){if(!/^\/health$|^\/state\/(groups|tasks|workflows)(\?|$)/u.test(path))throw Error('READONLY_ROUTE_REQUIRED');const response=await fetch(origin+path);if(!response.ok)throw Error(`READ_FAILED:${response.status}:${path}`);return response.json()}
const [health,groups,tasks]=await Promise.all(['/health','/state/groups','/state/tasks'].map(get))
const all=groups.flatMap(g=>g.outbox)
const pending=all.filter(n=>n.status==='pending')
const sources=new Map(await Promise.all([...new Set(all.map(n=>n.runId))].map(async runId=>{
 const data=await get('/state/workflows?runId='+encodeURIComponent(runId))
 return [runId,{run:{runId:data.run?.runId,status:data.run?.status,sourceVersion:data.run?.sourceVersion,revision:data.run?.revision},commands:data.commands?.map(c=>({commandId:c.commandId,kind:c.kind,status:c.status,result:{taskId:c.result?.taskId,runId:c.result?.runId,status:c.result?.status,observedAt:c.result?.observedAt}}))??[]}]
})))
const classify=n=>classifyOutboxNotification(n,{sources,tasks,rows:all})
const rows=groups.flatMap(g=>g.outbox.map(n=>({...n,...classify(n)})))
const counts=items=>Object.fromEntries(['obsolete','duplicate-or-delivered','valid-unsent','undetermined'].map(k=>[k,items.filter(x=>x.category===k).length]))
const evidence={observedAt:new Date().toISOString(),classificationCaveat:'公开completed投影不是退休授权；计划绑定不当前的Owner报告保留undetermined，自动启动仅按撤销策略分类，执行仍须正式CAS预检。',sources:['GET /health','GET /state/groups','GET /state/tasks','GET /state/workflows?runId=<id>'],outboundAuthorized:health.outboundAuthorized,groups:groups.map(g=>({groupId:g.groupId,total:g.outbox.length})),counts:counts(rows),pendingCounts:counts(rows.filter(n=>n.status==='pending')),rows,sourceFacts:Object.fromEntries(sources),taskFacts:tasks.map(t=>({taskId:t.taskId,state:t.state,outcome:t.outcome,inputVersion:t.inputVersion,runSequence:t.runSequence,taskRunId:t.taskRunId,result:t.result,plan:{version:t.plan?.version,requirementRevision:t.plan?.requirementRevision,requirementCurrent:t.plan?.requirementCurrent},taskOwner:{status:t.taskOwner?.status,decision:t.taskOwner?.decision,requirementRevision:t.taskOwner?.requirementRevision,controlRevision:t.taskOwner?.controlRevision,eventWatermark:t.taskOwner?.eventWatermark,processedWatermark:t.taskOwner?.processedWatermark}}))}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/outbox-audit.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({groups:evidence.groups,counts:evidence.counts,pendingCounts:evidence.pendingCounts,outboundAuthorized:health.outboundAuthorized}))
