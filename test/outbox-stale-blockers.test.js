import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {supersedeUnclaimedTaskRevisionNotifications as retire} from '../packages/dingtalk-dsh-assistant/message-ledger.js'
import {taskNotificationAllowed} from '../packages/dingtalk-dsh-assistant/workflow-notifications.js'
test('old wait/block conclusions retire atomically; unknown and delivered history stays reconcilable',()=>{
 const db=new DatabaseSync(':memory:')
 db.exec('CREATE TABLE task_reports(report_id TEXT,task_id TEXT,turn_id TEXT,report_type TEXT);CREATE TABLE task_owner_turns(turn_id TEXT,requirement_revision INTEGER);CREATE TABLE message_items(item_id TEXT,kind TEXT,body TEXT);CREATE TABLE execution_receipts(command_id TEXT,result TEXT);')
 for(const type of ['wait','block']){
  db.prepare('INSERT INTO task_owner_turns VALUES (?,?)').run(type,2)
  db.prepare('INSERT INTO task_reports VALUES (?,?,?,?)').run(type,'task',type,type)
  for(const status of ['prepared','unknown','acknowledged','delivered']){
   const id=type+status,n={id,status,leaseEpoch:status==='prepared'?0:1,payload:{phase:'owner:'+type,fact:{taskId:'task'}}}
   db.prepare('INSERT INTO message_items VALUES (?,?,?)').run(id,'notification',JSON.stringify(n))
  }
 }
 const read=()=>db.prepare('SELECT body FROM message_items ORDER BY item_id').all().map(r=>JSON.parse(r.body))
 const before=read();assert.equal(retire(db,'task',2,'now'),0)
 db.exec('BEGIN');assert.equal(retire(db,'task',3,'now'),2);db.exec('ROLLBACK');assert.deepEqual(read(),before)
 assert.equal(retire(db,'task',3,'now'),2);assert.equal(retire(db,'task',3,'later'),0)
 for(const n of read()) if(n.leaseEpoch===0){assert.equal(n.status,'superseded');assert.equal(n.supersededReason,'task-requirement-revised')}else assert.deepEqual(n,before.find(x=>x.id===n.id))
 db.close()
})
test('automatic start is silent; applied final result and structured user blocker remain eligible',()=>{
 assert.equal(taskNotificationAllowed({phase:'task:started',action:{kind:'create',status:'applied',result:{taskId:'t'}}}),false)
 assert.equal(taskNotificationAllowed({phase:'owner:r',report:{applicationStatus:'applied',reportType:'complete'}}),true)
 for(const reportType of ['progress','repairCurrentStage','future-type'])assert.equal(taskNotificationAllowed({phase:'owner:r',report:{applicationStatus:'applied',reportType,triggerTypes:['workflow.confirmation.required']}}),false)
 for(const kind of ['business-input','permission','execution','capability','approval'])assert.equal(taskNotificationAllowed({phase:'owner:r',report:{applicationStatus:'applied',reportType:'wait',facts:{condition:{kind,missing:'target',responsibleParty:'owner',resumeWhen:'confirmed'}}}}),['business-input','permission'].includes(kind))
})
