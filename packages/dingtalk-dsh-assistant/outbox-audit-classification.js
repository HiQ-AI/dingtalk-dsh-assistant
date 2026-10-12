const normalize=value=>typeof value==='string'?value.replace(/\s+/gu,' ').trim():null
export function classifyOutboxNotification(n,{sources,tasks,rows}){
 if(n.status==='sent')return{category:'duplicate-or-delivered',reason:'independently-delivered',messageId:n.deliveredMessageId}
 if(n.status==='superseded')return{category:'obsolete',reason:'formally-superseded'}
 const source=sources.get(n.runId),ids=[...new Set(source?.commands.map(c=>c.result.taskId).filter(Boolean)??[])]
 if(ids.length!==1)return{category:'undetermined',reason:'source-task-ambiguous-or-missing'}
 const taskId=ids[0],task=tasks.find(t=>t.taskId===taskId)
 const candidates=source.commands.filter(c=>c.result.taskId===taskId&&(n.phase==='receipt'?['status','result'].includes(c.kind):n.phase==='task:started'?['create','research'].includes(c.kind):true))
 if(n.phase==='receipt'&&candidates.length!==1||n.phase==='task:started'&&candidates.length!==1)return{category:'undetermined',reason:'notification-command-ambiguous',taskId}
 const action=candidates[0]
 // 旧启动意图已被当前通知策略撤销；不借公开completed推断业务终态。
 if(n.phase==='task:started'&&n.notificationStatus==='prepared'&&n.deliveryAttemptCount===0&&action?.status==='applied')
   return{category:'obsolete',reason:'automatic-start-policy-withdrawn',taskId,requiresFormalRetirementPreflight:true}
 const result=normalize(task?.result)
 const owner=task?.taskOwner
 const currentFinal=task?.state==='completed'&&task.plan?.requirementCurrent!==false&&owner?.decision==='complete'&&owner.status==='idle'
   &&Number.isSafeInteger(owner.eventWatermark)&&owner.eventWatermark===owner.processedWatermark
   &&task.inputVersion===owner.requirementRevision+1&&result
 const replacements=currentFinal?rows.filter(k=>k.status==='sent'&&k.deliveredMessageId&&k.groupId===n.groupId&&k.phase?.startsWith('owner:')
   &&k.phase!==n.phase&&Date.parse(k.createdAt)>Date.parse(n.createdAt)
   &&normalize(k.text)?.startsWith(result)
   &&new Set(sources.get(k.runId)?.commands.map(c=>c.result.taskId).filter(Boolean)).size===1
   &&sources.get(k.runId)?.commands.some(c=>c.result.taskId===taskId)):[]
 const kept=replacements.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0]
 if(!kept)return{category:'undetermined',reason:'current-delivered-replacement-unproven',taskId}
 let reason
 if(n.phase==='task:started'&&action.status==='applied'&&['create','research'].includes(action.kind))reason='late-start-after-delivered-completion'
 else if(n.phase?.startsWith('owner:'))reason='older-owner-report-replaced-by-current-delivered-conclusion'
 else if(n.phase==='receipt'&&action.status==='applied'&&['status','result'].includes(action.kind)
   &&action.result.runId&&task.taskRunId&&action.result.runId!==task.taskRunId)reason='old-query-run-replaced-by-current-delivered-conclusion'
 if(!reason)return{category:'undetermined',reason:'notification-staleness-unproven',taskId}
 return{category:'obsolete',reason,taskId,inputVersion:task.inputVersion,runSequence:task.runSequence,latestRunId:task.taskRunId,
   oldRunId:action.result.runId??null,oldReportId:n.phase?.startsWith('owner:')?n.phase.slice(6):null,
   supersededByNotificationId:kept.outboundId,replacementMessageId:kept.deliveredMessageId,replacementPhase:kept.phase}
}
