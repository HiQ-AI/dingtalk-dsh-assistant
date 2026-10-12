import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import{supersedeUnclaimedCompletionNotifications as invalidate}from'../packages/dingtalk-dsh-assistant/message-ledger.js';
function fixture(){const d=new DatabaseSync(':memory:');d.exec('CREATE TABLE task_reports(report_id TEXT,task_id TEXT,turn_id TEXT,report_type TEXT);CREATE TABLE task_owner_turns(turn_id TEXT,requirement_revision INTEGER);CREATE TABLE message_items(item_id TEXT,kind TEXT,body TEXT);CREATE TABLE execution_receipts(command_id TEXT,result TEXT);CREATE TABLE successful_history(kind TEXT,body TEXT);');d.prepare('INSERT INTO task_owner_turns VALUES (?,?)').run('turn',2);d.prepare('INSERT INTO task_reports VALUES (?,?,?,?)').run('owner:turn','sg20','turn','complete');d.prepare('INSERT INTO successful_history VALUES (?,?)').run('run','17 nodes succeeded;8 effects succeeded;PR370');return d}
function add(d,id,status='prepared',lease=0,task='sg20',phase='owner:owner:turn'){const n={id,status,leaseEpoch:lease,payload:{phase,fact:{taskId:task},conversationId:'original-group',sourceMessageId:'original-message'}};d.prepare('INSERT INTO message_items VALUES (?,?,?)').run(id,'notification',JSON.stringify(n));return n}
const read=(d,id)=>JSON.parse(d.prepare('SELECT body FROM message_items WHERE item_id=?').get(id).body);
test('revision supersedes only old unclaimed completion, preserves successful Run/PR/source/history',()=>{const d=fixture();const original=add(d,'old');add(d,'other','prepared',0,'sg19');add(d,'start','prepared',0,'sg20','task:started');d.exec('BEGIN');assert.equal(invalidate(d,'sg20',3,'now'),1);d.exec('COMMIT');const n=read(d,'old');assert.equal(n.status,'superseded');assert.deepEqual(n.payload,original.payload);assert.equal(read(d,'other').status,'prepared');assert.equal(read(d,'start').status,'prepared');assert.equal(d.prepare('SELECT count(*) n FROM successful_history').get().n,1);assert.equal(d.prepare('SELECT count(*) n FROM task_reports').get().n,1);assert.equal(invalidate(d,'sg20',3,'later'),0);d.close()});
test('claimed/sending/unknown/sent require reconciliation and are untouched',()=>{const d=fixture();for(const [id,status,lease]of[['claimed','prepared',1],['sending','sending',1],['unknown','unknown',1],['sent','sent',1]])add(d,id,status,lease);const before=d.prepare('SELECT body FROM message_items').all();assert.equal(invalidate(d,'sg20',3,'now'),0);assert.deepEqual(d.prepare('SELECT body FROM message_items').all(),before);d.close()});
test('ordinary same-revision context leaves completion alone; transaction rollback atomic',()=>{const d=fixture();add(d,'old');assert.equal(invalidate(d,'sg20',2,'now'),0);d.exec('BEGIN');invalidate(d,'sg20',3,'now');d.exec('ROLLBACK');assert.equal(read(d,'old').status,'prepared');assert.equal(d.prepare('SELECT count(*) n FROM successful_history').get().n,1);d.close()});

test('legacy start is retired only by its persisted acceptance version',()=>{
 const d=fixture();
 for(const [id,revision,task,status,lease] of [['old-start',1,'sg20','prepared',0],['current-start',3,'sg20','prepared',0],['other-start',1,'sg19','prepared',0],['claimed-start',1,'sg20','prepared',1]]){
  const n=add(d,id,status,lease,task,'task:started');n.commandId=id;n.eventKey=`task.started:${task}`;
  d.prepare('UPDATE message_items SET body=? WHERE item_id=?').run(JSON.stringify(n),id);
  d.prepare('INSERT INTO execution_receipts VALUES (?,?)').run(`task-accept:${id}`,JSON.stringify({result:{taskId:task,requirementRevision:revision}}));
 }
 const before=read(d,'old-start');assert.equal(invalidate(d,'sg20',3,'now'),1);
 assert.equal(read(d,'old-start').status,'superseded');assert.deepEqual(read(d,'old-start').payload,before.payload);
 for(const id of ['current-start','other-start','claimed-start'])assert.equal(read(d,id).status,'prepared');d.close();
});
test('missing or mismatched creation evidence leaves ambiguous starts untouched',()=>{
 const d=fixture();for(const id of ['missing','wrong-task']){const n=add(d,id,'prepared',0,'sg20','task:started');n.commandId=id;n.eventKey='task.started:sg20';d.prepare('UPDATE message_items SET body=? WHERE item_id=?').run(JSON.stringify(n),id)}
 d.prepare('INSERT INTO execution_receipts VALUES (?,?)').run('task-accept:wrong-task',JSON.stringify({result:{taskId:'sg19',requirementRevision:1}}));
 assert.equal(invalidate(d,'sg20',3,'now'),0);d.close();
});
