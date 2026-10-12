import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {currentOwnerCompletion,isQuietGroupMessage,assertMessageTaskUnfenced} from '../packages/dingtalk-dsh-assistant/message-ledger.js'
function fixture(){
 const db=new DatabaseSync(':memory:')
 db.exec(`CREATE TABLE business_tasks(task_id TEXT,requirement_revision INTEGER,plan_revision INTEGER,plan_requirement_revision INTEGER);CREATE TABLE task_controls(task_id TEXT,control_revision INTEGER);CREATE TABLE task_owner_turns(turn_id TEXT,application_status TEXT,requirement_revision INTEGER,plan_revision INTEGER,control_revision INTEGER);CREATE TABLE task_reports(report_id TEXT,task_id TEXT,turn_id TEXT,report_type TEXT);CREATE TABLE task_events(task_id TEXT,event_type TEXT,handled_at TEXT);INSERT INTO business_tasks VALUES('task',2,3,2);INSERT INTO task_controls VALUES('task',4);INSERT INTO task_owner_turns VALUES('turn','applied',2,3,4);INSERT INTO task_reports VALUES('report','task','turn','complete')`)
 return {db,notice:{payload:{phase:'owner:report',fact:{taskId:'task',sourceVersion:1,runRevision:1}}}}
}
test('applied task completion remains current across history and context-only observation metadata',()=>{
 const {db,notice}=fixture();try{assert.equal(currentOwnerCompletion(db,notice),true);for(const type of ['topic.fact','query.succeeded','workflow.succeeded'])db.prepare('INSERT INTO task_events VALUES(?,?,NULL)').run('task',type);notice.payload.fact.sourceVersion=99;notice.payload.fact.runRevision=99;assert.equal(currentOwnerCompletion(db,notice),true)}finally{db.close()}
})
test('new business input, changed requirement or control and unapplied result invalidate completion',()=>{
 for(const change of ["INSERT INTO task_events VALUES('task','intent.received',NULL)","INSERT INTO task_events VALUES('task','source.related',NULL)","UPDATE business_tasks SET requirement_revision=3","UPDATE task_controls SET control_revision=5","UPDATE task_owner_turns SET application_status='pending'"]){const {db,notice}=fixture();try{db.exec(change);assert.equal(currentOwnerCompletion(db,notice),false)}finally{db.close()}}
})
test('pure progress acknowledgements do not become pending business input; extra requirements still block',()=>{
 assert.equal(isQuietGroupMessage('@李辰  任务已开始处理。  \n- 小小鹏代回'),true);
 assert.equal(isQuietGroupMessage('任务已开始处理'),true);
 for(const body of ['任务已开始处理。请增加键盘导航','@李辰 任务已开始处理。暂停此任务','任务已开始处理失败，需要修改','已开始处理，新需求如下'])assert.equal(isQuietGroupMessage(body),false);
})

test('task input guard admits pending pure progress but blocks appended business instructions',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(`CREATE TABLE task_events(task_id TEXT,event_type TEXT,seq INTEGER,event_key TEXT,handled_at TEXT,turn_id TEXT);CREATE TABLE task_owner_turns(turn_id TEXT,status TEXT,application_status TEXT,event_watermark INTEGER,task_id TEXT);CREATE TABLE message_runs(run_id TEXT,source_key TEXT,source_version INTEGER,body TEXT);CREATE TABLE message_sources(source_key TEXT,current_version INTEGER);CREATE TABLE message_items(item_id TEXT,run_id TEXT,kind TEXT,body TEXT);CREATE TABLE message_topic_bindings(unit_id TEXT,run_id TEXT,topic_id TEXT);`);
 const put=(id,body)=>{db.prepare('INSERT INTO message_runs VALUES(?,?,1,?)').run(id,id,JSON.stringify({runId:id,sourceKey:id,sourceVersion:1,conversationId:'group',...body}));db.prepare('INSERT INTO message_sources VALUES(?,1)').run(id)};
 put('origin',{status:'settled',reason:'message_quiet'});put('progress',{status:'pending',body:'@李辰 任务已开始处理。\n- 小小鹏代回'});db.prepare('INSERT INTO message_items VALUES(?,?,?,?)').run('command','origin','command',JSON.stringify({args:{taskId:'task'},status:'succeeded',kind:'create'}));
 assert.doesNotThrow(()=>assertMessageTaskUnfenced(db,'task'));
 const original=JSON.parse(db.prepare('SELECT body FROM message_runs WHERE run_id=?').get('progress').body);original.body+='\n请增加键盘导航';db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(original),'progress');assert.throws(()=>assertMessageTaskUnfenced(db,'task'),/MESSAGE_INPUT_PENDING/); original.body='先别做';db.prepare('UPDATE message_runs SET body=? WHERE run_id=?').run(JSON.stringify(original),'progress');assert.throws(()=>assertMessageTaskUnfenced(db,'task'),/MESSAGE_INPUT_PENDING/);
 }finally{db.close()}
})
