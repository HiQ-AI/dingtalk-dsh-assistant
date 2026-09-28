import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'

const root=resolve(process.argv[2])
const read=async name=>JSON.parse((await readFile(resolve(root,name),'utf8')).replace(/^\uFEFF/,''))
const chat=await read('channel-final.json')
assert.equal(chat.complete,true);assert.equal(chat.hasMore,false);assert.equal(chat.failedCount,0)
const status=await Promise.all(['a','b','c'].map(name=>read(`status-${name}.json`)))
status.forEach(item=>assert.equal(item.result.sendStatus,'SUCCESS'))
const replies=status.map(item=>chat.messages.filter(message=>message.quotedMessage?.messageId===item.messageRef.openMessageId))
assert.equal(replies[0].length,1);assert.equal(replies[1].length,2);assert.equal(replies[2].length,2)
const internal=/任务\s*(?:id|编号)|会话\s*(?:id|编号)|任务会话|当前绑定|平台机制|MESSAGE_[A-Z_]+|(?:task|msg)-[a-f0-9]{20}|workflow-v2|Runtime|Outbox/iu
for(const message of replies.flat()){
 assert.doesNotMatch(message.text,internal)
 assert.match(message.text,/- 小小鹏代回/u)
}
for(const text of [replies[0][0].text,replies[2].find(item=>item.text.includes('任务已完成')).text]){
 for(const value of ['说明.md','查询.sql','尚未发送','PR #131','已合并','尚未部署'])assert.ok(text.includes(value),value)
}
assert.ok(replies[1].some(item=>item.text.includes('请确认具体上线日期')))
assert.ok(replies[1].some(item=>item.text.includes('2026 年 10 月 1 日')&&item.text.includes('测试素材')))
const old=await read('blocked-before.json'),after=await read('old-after.json'),recovered=await read('recovery-readback.json')
assert.equal(after.run.status,'superseded');assert.equal(recovered.run.status,'settled')
assert.equal(recovered.run.sourceVersion,old.run.sourceVersion+1)
assert.equal(recovered.commands.length,0)
assert.equal(recovered.requests[0].answer,old.requests[0].answer)
assert.equal(recovered.requests[0].eventId,old.requests[0].eventId)
assert.deepEqual(after.requests,old.requests)
const beforeGroup=await read('group-before.json'),afterGroup=await read('group-after.json')
const notices=beforeGroup.outbox.filter(item=>item.sourceMessageId===old.run.context.sourceMessageId)
assert.equal(notices.length,1)
assert.deepEqual(afterGroup.outbox.find(item=>item.outboundId===notices[0].outboundId),notices[0])
assert.equal(notices[0].deliveryAttemptCount,1)
const baseline=await read('evidence/tasks-before.json'),beforeC=await read('tasks-c.json'),tasks=await read('tasks-final.json')
const ids=items=>items.map(item=>item.taskId).sort()
assert.deepEqual(ids(beforeC),ids(baseline))
const added=tasks.filter(item=>!baseline.some(prior=>prior.taskId===item.taskId))
assert.equal(added.length,1);assert.equal(added[0].state,'completed')
assert.ok(added[0].objective.includes('演练素材'))
const health=await read('health-final.json'),deployment=await read('final-readback.json')
assert.equal(health.status,'ok');assert.equal(health.recoveryIssueCount,0)
assert.equal(deployment.ready,true);assert.equal(deployment.dispatchResumed,true)
assert.equal(deployment.package.verifiedFiles,95)
const result={passed:true,cases:['original-notice-preserved','accepted-answer-inherited','no-replayed-business-command','ordinary-answer','clarification-and-answer','owner-completion-report'],newTasks:added.length,health:health.status,pid:deployment.pid,
 transcripts:replies.map((messages,index)=>({case:['A','B','C'][index],texts:messages.map(item=>item.text)}))}
await writeFile(resolve(root,'acceptance-result.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({passed:result.passed,cases:result.cases,newTasks:result.newTasks,health:result.health,pid:result.pid}))
