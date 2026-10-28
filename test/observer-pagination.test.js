import {observerWorkMetadata} from '../packages/dingtalk-dsh-assistant/observer-work-index.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installObserverPagination, observerPage } from '../packages/dingtalk-dsh-assistant/observer-pagination.js'

function fixture(t) {
 const db = new DatabaseSync(':memory:');t.after(()=>db.close())
 for(const name of ['tasks','executions','wakes','coordination_sources','sources','notifications','coordination']) db.exec(`CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT)`)
 const put=(table,id,value)=>db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id,JSON.stringify({id,...value}))
 installObserverPagination(db,{migrate:true})
 return {db,put,page:q=>observerPage(db,q,'test')}
}
test('page materialization is bounded, ordered and count uses metadata, not historical bodies',t=>{
 const {db,put}=fixture(t)
 db.exec('BEGIN')
 for(let n=0;n<1000;n++) put('tasks',`t${String(n).padStart(4,'0')}`,{taskId:`t${n}`,groupId:'g',status:'active',control:'active',drained:true,updatedAt:'same',dialogue:[{text:'large omitted dialogue'}]})
 db.exec('COMMIT')
 let materialized=0;const sql=[]
 const observed={prepare(query){sql.push(query);const statement=db.prepare(query);return {get:(...a)=>statement.get(...a),all:(...a)=>{const rows=statement.all(...a);if(query.includes(' AS body'))materialized+=rows.length;return rows}}}}
 const result=observerPage(observed,{collection:'tasks',state:'waiting',offset:510,limit:10},'test')
 assert.equal(result.total,1000);assert.equal(result.items.length,10);assert.equal(materialized,10)
 assert.equal(result.items[0].id,'t0510');assert.equal(result.items[0].dialogue,undefined)
 assert(sql.some(q=>q.includes('count(*) AS n FROM observer_task_index i')))
 assert(sql.some(q=>q.includes('WITH page_ids AS MATERIALIZED (SELECT i.* FROM observer_task_index i')))
 // A terminal-state OR may require sorting, but only the materialized IDs are sorted.
 put('tasks','done',{taskId:'done',status:'completed',updatedAt:'same'})
 put('tasks','cancelled',{taskId:'cancelled',control:'cancelled',updatedAt:'same'})
 assert.equal(observerPage(observed,{collection:'tasks',state:'completed',limit:1},'test').items.length,1)
 const plan=db.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM observer_task_index WHERE archived=0 AND state=?').all('waiting')
 assert(plan.some(row=>row.detail.includes('COVERING INDEX')))
})
test('updates between pages are rejected rather than silently duplicating or skipping rows',t=>{
 const {put,page}=fixture(t)
 for(const id of ['a','b','c'])put('tasks',id,{taskId:id,status:'active',drained:true,updatedAt:'same'})
 const first=page({collection:'tasks',limit:2})
 assert.deepEqual(first.items.map(v=>v.id),['a','b'])
 assert.deepEqual(page({collection:'tasks',offset:2,limit:2,revision:first.revision}).items.map(v=>v.id),['c'])
 put('tasks','a',{taskId:'a',status:'active',drained:true,updatedAt:'new'})
 assert.throws(()=>page({collection:'tasks',offset:2,limit:2,revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
})
test('board membership follows execution, wake, human, cancel and archive changes transactionally',t=>{
 const {put,page}=fixture(t)
 const task={taskId:'t',groupId:'g',status:'active',control:'active',drained:true}
 put('tasks','t',task)
 assert.equal(page({collection:'tasks',state:'waiting'}).total,1)
 put('executions','e',{taskId:'t',status:'queued',drained:true})
 assert.equal(page({collection:'tasks',state:'running'}).total,1)
 put('tasks','t',{...task,humanRequests:[{status:'waiting-reply'}]})
 assert.equal(page({collection:'tasks',state:'waiting'}).total,1)
 put('tasks','t',{...task,control:'cancelled'})
 assert.equal(page({collection:'tasks',state:'completed'}).total,1)
 put('tasks','t',{...task,archivedAt:'2026-10-28'})
 assert.equal(page({collection:'tasks'}).total,0)
 assert.equal(page({collection:'tasks',archived:true}).total,1)
})
test('execution/source bodies only deserialize requested page and preserve stable order',t=>{
 const {put,page}=fixture(t)
 for(let n=0;n<22;n++){put('executions',`e${n}`,{taskId:'t',prompt:'body'});put('coordination_sources',`s${String(n).padStart(2,'0')}`,{groupId:'g',createdAt:'same'})}
 const executions=page({collection:'executions',taskId:'t',offset:20,limit:2})
 assert.equal(executions.total,22);assert.deepEqual(executions.items.map(i=>i.id),['e20','e21']);assert.equal(executions.nextOffset,null)
 const sources=page({collection:'coordination-sources',groupId:'g',offset:10,limit:2})
 assert.equal(sources.total,22);assert.deepEqual(sources.items.map(i=>i.id),['s10','s11'])
})
test('GET pagination never initializes or migrates an existing ledger',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 assert.equal(installObserverPagination(db),false)
 assert.throws(()=>observerPage(db,{collection:'tasks'},'test'),{code:'OBSERVER_PAGINATION_MIGRATION_REQUIRED'})
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'observer_%'").get().n,0)
})

test('authorization paging reads individual request JSON and its exact operator notice',t=>{
 const {put,page}=fixture(t)
 const requests=Array.from({length:53},(_,i)=>({requestId:`r${String(i).padStart(2,'0')}`,status:i%2?'answered':'waiting-reply',createdAt:'same',question:`Question ${i}`}))
 put('tasks','t',{taskId:'t',groupId:'g',status:'active',drained:true,humanRequests:requests,objective:'Synthetic objective',dialogue:Array(1000).fill({text:'never return task dialogue'})})
 put('notifications','notice',{taskId:'t',payload:{humanRequestId:'r20',audience:'operator'},state:'delivered'})
 const selected=page({collection:'authorizations',filter:'pending',offset:10,limit:1})
 assert.equal(selected.total,27);assert.equal(selected.items.length,1)
 assert.equal(selected.items[0].humanRequests.length,1);assert.equal(selected.items[0].humanRequests[0].requestId,'r20')
 assert.equal(selected.items[0].observerNotice.id,'notice');assert.equal(selected.items[0].dialogue,undefined)
 assert.equal(page({collection:'authorizations',taskId:'t',requestId:'r52',limit:1}).items[0].humanRequests[0].question,'Question 52')
})

test('topic-task association paging covers archived tasks and source-group overrides',t=>{
 const {put,page}=fixture(t)
 for(let i=0;i<31;i++)put('tasks',`t${String(i).padStart(2,'0')}`,{taskId:`t${i}`,groupId:'web:g',sourceGroupId:'g',status:'active',drained:true,topicRefs:[{topicId:'topic',revision:1}],updatedAt:'same',...(i%2?{archivedAt:'at'}:{})})
 const result=page({collection:'tasks',groupId:'g',topicId:'topic',archived:'all',offset:20,limit:10})
 assert.equal(result.total,31);assert.equal(result.items.length,10);assert.equal(result.items[0].id,'t20')
 put('tasks','t20',{taskId:'t20',groupId:'other',status:'active',drained:true,topicRefs:[]})
 assert.equal(page({collection:'tasks',groupId:'g',topicId:'topic',archived:'all'}).total,30)
})


test('work SQL read model excludes historical bodies while retaining the exact retry proof',t=>{
 const {db,put}=fixture(t)
 for(const name of ['coordination_members','coordination_schedules','coordination_occurrences','coordination_jobs','receipts'])db.exec(`CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT)`)
 const large='body-that-must-not-be-projected'.repeat(5000)
 put('coordination','c',{groupId:'g',title:'Work',proposal:{text:large}})
 put('coordination_members','m',{coordinationId:'c',taskId:'t',requirement:large,completionProof:{eventId:'event',hidden:large},waitingReason:{code:'synthetic',detail:large},command:{id:'cmd',kind:'task.supplement',args:{text:'Instruction',hidden:large}}})
 put('tasks','t',{taskId:'t',request:'short',dialogue:[{text:large}]})
 put('executions','e',{taskId:'t',prompt:large,result:{reply:large}})
 put('receipts','cmd',{result:{task:{taskId:'t'},sensitive:large}})
 put('coordination_occurrences','o',{coordinationId:'c',notificationId:'n'})
 const proof={category:'api',code:1,origin:'mcp_gateway',operation:'chat/get_conversation_info',reason:'topic_quote_guard_unavailable',retryable:true,message:'Synthetic refusal'}
 put('notifications','n',{state:'failed',payload:{conversationId:'g',sourceMessageId:'message',text:large},deliveryError:{phase:'send',knownNotSent:true,retryable:true,exitCode:1,stdout:'',stderr:JSON.stringify({error:proof,ignored:large})}})
 const sql=[];const observed={prepare(query){sql.push(query);return db.prepare(query)}}
 const model=observerWorkMetadata(observed,{groupId:'g'}),json=JSON.stringify(model)
 assert(!json.includes(large));assert.equal(model.executions[0].prompt,undefined);assert.equal(model.receipts[0].id,'cmd')
 const error=model.notifications[0].deliveryError
 assert.equal(error.knownNotSent,true);assert.equal(error.retryable,true);assert.equal(error.stdout,'');assert.deepEqual(JSON.parse(error.stderr),{error:proof})
 assert(sql.filter(query=>query.includes(' AS body')||query.includes('}) body')).every(query=>!/^SELECT body FROM/.test(query)))
})
