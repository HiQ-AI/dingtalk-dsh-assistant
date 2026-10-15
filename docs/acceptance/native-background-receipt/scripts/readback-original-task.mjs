import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
const taskId='task-4c4780a541c5ea7c51024975de5f121d'
const db=new DatabaseSync('D:/baibu-agent/.dsh/task-sessions.sqlite',{readOnly:true})
try {
 const rows=table=>db.prepare('SELECT body FROM dynamic_'+table).all().map(row=>JSON.parse(row.body))
 const task=rows('tasks').find(row=>row.taskId===taskId)
 const executions=rows('executions').filter(row=>row.taskId===taskId)
 const operations=rows('operations').filter(row=>row.taskId===taskId)
 const original=operations.find(row=>row.operationId==='operation-dd0590820dd7589b071f8caeb85284f5c19dba8f')
 const edit=operations.find(row=>row.operationId==='operation-7c546ed0d83e2aee0cc01073c65b4e64a8c2ad80')
 const session='task-execution-9b11f09e-1ede-4e07-8e66-a9d104bdbbf6'
 const log='D:/baibu-agent/tasks/'+taskId+'/.dsh/sessions/--D-baibu-agent-tasks-'+taskId+'--/'+session+'/session.v4.jsonl'
 const events=readFileSync(log,'utf8').trim().split(/\r?\n/u).map(line=>JSON.parse(line))
 console.log(JSON.stringify({at:new Date().toISOString(),task:{taskId,sessionId:task.sessionId,status:task.status,drained:task.drained,
  decision:task.lastDecision?.summary,pending:task.humanRequests.filter(row=>row.status==='waiting-reply').map(row=>({requestId:row.requestId,question:row.question})),requirementRevision:task.requirementRevision,controlRevision:task.controlRevision},
  original:{operationId:original.operationId,state:original.state,jobId:original.job?.jobId,jobStatus:original.job?.status,finishedAt:original.job?.finishedAt,detail:original.job?.detail},
  edit:edit&&{state:edit.state,result:edit.result},executions:executions.map(row=>({executionId:row.executionId,sessionId:row.sessionId,status:row.status,drained:row.drained,inputVersion:row.inputVersion,summary:row.result?.payload?.output?.summary})),
  log:{lastSeq:events.at(-1).seq,end:events.findLast(row=>row.type==='turn/end')?.data.reason,
  calls:events.filter(row=>row.type==='tool/call'&&row.seq>=291).map(row=>({seq:row.seq,name:row.data.name,...(['pwsh','execution_submit'].includes(row.data.name)?{arguments:row.data.arguments}: {})}))},
  busy:rows('executions').filter(row=>row.drained===false).map(row=>({executionId:row.executionId,taskId:row.taskId,status:row.status})),
  starting:rows('operations').filter(row=>row.state==='starting').map(row=>({operationId:row.operationId,taskId:row.taskId,tool:row.definition.toolName}))},null,2))
} finally {db.close()}
