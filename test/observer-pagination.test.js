import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {executionSessionTitle} from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import {latestExecutionRoundTiming} from '../packages/dingtalk-dsh-assistant/task-execution-timeline.js'
import {observerWorkMetadata} from '../packages/dingtalk-dsh-assistant/observer-work-index.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, constants } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { installObserverPagination, installObserverArchivePagination, observerPage, observerGroupQuery } from '../packages/dingtalk-dsh-assistant/observer-pagination.js'

function fixture(t,{archives=false}={}) {
 const db = new DatabaseSync(':memory:');t.after(()=>db.close())
 for(const name of ['tasks','executions','wakes','coordination_sources','sources','notifications','coordination']) db.exec(`CREATE TABLE dynamic_${name}(id TEXT PRIMARY KEY,body TEXT)`)
 const put=(table,id,value)=>db.prepare(`INSERT INTO dynamic_${table}(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id,JSON.stringify({id,...value}))
 if(archives)for(const name of ['tasks','executions','wakes','notifications','receipts'])db.exec(`CREATE TABLE dynamic_archived_${name}(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,body TEXT)` )
 installObserverPagination(db,{migrate:true})
 return {db,put,page:q=>observerPage(db,q,'test')}
}
test('task page joins only selected topic names once per group/id without reading topic history', async t => {
 const {put,page}=fixture(t)
 const refs=[{topicId:'shared',revision:2},{groupId:'other',topicId:'shared',revision:4},{topicId:'missing',revision:1}]
 for(let i=0;i<3;i++)put('tasks',`t${i}`,{taskId:`t${i}`,groupId:'web:g',sourceGroupId:'g',status:'active',control:'active',drained:true,updatedAt:'same',topicRefs:i<2?refs:[{topicId:'off-page',revision:1}]})
 const source=await readFile(new URL('../packages/dingtalk-dsh-assistant/task-session-service.js',import.meta.url),'utf8')
 const projection=source.slice(source.indexOf('  const taskTopicRefs ='),source.indexOf('  const taskDTO ='))
 const method=source.slice(source.indexOf('    async boardTasks(options)'),source.indexOf('    async taskDecisions('))
 const lookups=[],queries=[]
 const board=runInNewContext(`(()=>{${projection};return ({${method}}).boardTasks})()`,{Map,dirname,root:'/fixture',taskFilePath:(...args)=>join(...args),taskSessionLogRoot:()=>'/log',
  residentStore:{getTopic(groupId,topicId){lookups.push([groupId,topicId]);return topicId==='missing'?undefined:{title:groupId==='g'?'事项甲':'事项乙',get messages(){throw new Error('topic history must not be projected')}}}},
  query:async(kind,args)=>{queries.push(kind);assert.equal(kind,'observer.page');return page(args)}})
 const result=await board({offset:0,limit:2,state:'waiting'})
 assert.equal(result.total,3);assert.equal(result.items.length,2)
 assert.deepEqual(lookups,[['g','shared'],['other','shared'],['g','missing']])
 assert.deepEqual(queries,['observer.page'])
 for(const task of result.items){assert.deepEqual(Array.from(task.topicRefs,ref=>ref.title),['事项甲','事项乙',null]);assert.equal(task.topicRefs[1].revision,4);assert.equal(task.topicRefs[1].groupId,'other');assert.equal(task.topicRefs[0].messages,undefined)}
 assert.equal(page({collection:'tasks',offset:0,limit:1}).items[0].topicRefs[0].title,undefined,'名称仅做读取投影，不回写任务引用')
})
test('history task pages skip execution counts and session navigation while details stay paged', async t => {
 const {db,put,page}=fixture(t,{archives:true})
 for(let i=0;i<3;i++) {
  put('tasks',`history-${i}`,{taskId:`history-${i}`,status:'completed',drained:true,archivedAt:'time',updatedAt:'same',title:'历史事项'})
  put('executions',`execution-${i}`,{executionId:`execution-${i}`,taskId:`history-${i}`,status:'succeeded',drained:true,input:{title:'既有执行'}})
 }
 db.exec('INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks; DELETE FROM dynamic_tasks;')
 let executionReads=0
 db.setAuthorizer((action,table)=>{if(action===constants.SQLITE_READ&&['observer_execution_index','dynamic_executions','dynamic_archived_executions'].includes(table)){executionReads++;return constants.SQLITE_DENY}return constants.SQLITE_OK})
 try {
  const source=await readFile(new URL('../packages/dingtalk-dsh-assistant/task-session-service.js',import.meta.url),'utf8')
  const projection=source.slice(source.indexOf('  const taskTopicRefs ='),source.indexOf('  const taskDTO ='))
  const method=source.slice(source.indexOf('    async boardTasks(options)'),source.indexOf('    async taskDecisions('))
  const board=runInNewContext(`(()=>{${projection};return ({${method}}).boardTasks})()`,{Map,query:async(kind,args)=>{assert.equal(kind,'observer.page');return page(args)},
   dirname,root:'/fixture',taskFilePath(){throw new Error('history list must not build execution navigation')},taskSessionLogRoot(){throw new Error('history list must not build log paths')}})
  const first=await board({archived:true,limit:2}),last=await board({archived:true,offset:first.nextOffset,limit:2,revision:first.revision})
  assert.equal(first.total,3);assert.equal(first.items.length,2);assert.equal(last.items.length,1);assert.equal(last.nextOffset,null)
  for(const task of [...first.items,...last.items])for(const field of ['executionCount','completedExecutionCount','session'])assert.equal(Object.hasOwn(task,field),false,field)
  assert.equal(executionReads,0)
 } finally {db.setAuthorizer(null)}
 put('tasks','current',{taskId:'current',status:'active',control:'active',drained:true,updatedAt:'same'})
 put('executions','current-execution',{executionId:'current-execution',taskId:'current',status:'succeeded',drained:true})
 const mixed=page({collection:'tasks',archived:'all'})
 assert.equal(mixed.items.find(task=>task.taskId==='current').completedExecutionCount,1)
 assert(mixed.items.filter(task=>task.archivedAt).every(task=>!Object.hasOwn(task,'executionCount')))
 const detail=page({collection:'executions',taskId:'history-0',summary:true,limit:1})
 assert.equal(detail.total,1);assert.equal(detail.items[0].executionId,'execution-0')
})
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



test('archive move retains task/topic/human indexes and materializes only selected primary keys',t=>{
 const {db,put,page}=fixture(t,{archives:true})
 for(let n=0;n<1000;n++)put('tasks',`t${String(n).padStart(4,'0')}`,{taskId:`t${n}`,groupId:'g',status:'completed',drained:true,updatedAt:'same',archivedAt:'archive',topicRefs:[{topicId:'topic'}],humanRequests:[{requestId:`r${n}`,status:'answered',createdAt:'same',question:'full question'}],request:'full request '.repeat(300)})
 db.exec('INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks; DELETE FROM dynamic_tasks;')
 assert.equal(db.prepare('SELECT count(*) n FROM observer_task_index').get().n,1000)
 const seen=[];const observed={prepare(sql){const st=db.prepare(sql);return {get:(...a)=>st.get(...a),all:(...a)=>{const rows=st.all(...a);if(sql.includes(' AS body'))seen.push({sql,args:a,rows:rows.length});return rows}}}}
 const result=observerPage(observed,{collection:'tasks',archived:true,topicId:'topic',groupId:'g',offset:510,limit:10},'test')
 assert.equal(result.total,1000);assert.equal(result.items.length,10)
 assert(result.items.every(item=>item.request.length>400&&item.archivedAt==='archive'))
 assert.equal(seen.reduce((n,x)=>n+x.rows,0),10)
 const plan=db.prepare('EXPLAIN QUERY PLAN '+seen[0].sql).all(...seen[0].args)
 assert(plan.some(row=>/SEARCH a USING INDEX/.test(row.detail)));assert(!plan.some(row=>/SCAN [ad]$/.test(row.detail)))
 assert.equal(page({collection:'tasks',limit:10}).total,0)
 assert.equal(page({collection:'authorizations',taskId:'t0000',requestId:'r0',limit:1}).items[0].humanRequests[0].question,'full question')
 const revision=result.revision;put('tasks','live',{taskId:'live',status:'active',drained:true,updatedAt:'later'})
 assert.throws(()=>page({collection:'tasks',archived:true,offset:520,limit:10,revision}),{code:'OBSERVER_PAGE_STALE'})
})

test('archived execution summaries and exact authorization notice remain readable',t=>{
 const {db,put,page}=fixture(t,{archives:true})
 put('tasks','task',{taskId:'task',status:'completed',drained:true,archivedAt:'archive',humanRequests:[{requestId:'request',status:'answered',createdAt:'time',question:'full question '.repeat(100)}]})
 for(let n=0;n<23;n++)put('executions',`e${n}`,{executionId:`e${n}`,taskId:'task',status:'succeeded',drained:true,input:{title:'title',prompt:'large prompt'},createdAt:'same'})
 put('notifications','notice',{id:'notice',taskId:'task',payload:{humanRequestId:'request',audience:'operator',text:'full notice',conversationId:'g',sourceMessageId:'message'}})
 db.exec('INSERT INTO dynamic_archived_executions SELECT id,rowid,body FROM dynamic_executions; DELETE FROM dynamic_executions; INSERT INTO dynamic_archived_notifications SELECT id,rowid,body FROM dynamic_notifications; DELETE FROM dynamic_notifications; INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks; DELETE FROM dynamic_tasks;')
 const first=page({collection:'executions',taskId:'task',summary:true,limit:10}), second=page({collection:'executions',taskId:'task',summary:true,offset:10,limit:10,revision:first.revision}),last=page({collection:'executions',taskId:'task',summary:true,offset:20,limit:10,revision:first.revision})
 assert.equal(first.total,23);assert.equal(last.items.length,3);assert.equal(new Set([...first.items,...second.items,...last.items].map(x=>x.executionId)).size,23)
 assert.equal(first.items[0].input.prompt,undefined)
 const authorization=page({collection:'authorizations',taskId:'task',requestId:'request',limit:1}).items[0]
 assert.equal(authorization.observerNotice.payload.text,'full notice')
 assert.equal(authorization.humanRequests[0].question,'full question '.repeat(100))
 assert.equal(Object.hasOwn(page({collection:'tasks',archived:true,limit:1}).items[0],'executionCount'),false)
 assert.equal(observerGroupQuery(db,{kind:'observer.message-contexts',groupId:'g',messageIds:['message']}).notifications[0].payload.text,'full notice')
 db.exec("DELETE FROM dynamic_archived_tasks WHERE id='task'");assert.equal(page({collection:'tasks',archived:true,limit:1}).total,0)
 db.exec("INSERT INTO observer_task_index VALUES('missing',NULL,'completed',1,'same')")
 assert.throws(()=>page({collection:'tasks',archived:true,limit:1}),{code:'OBSERVER_PAGE_DATA_MISSING'})
})


test('work metadata retains archived completion and command proof without materializing archived payloads',t=>{
 const {db,put}=fixture(t,{archives:true}),large='historical payload '.repeat(10000)
 for(const table of ['coordination_members','coordination_schedules','coordination_occurrences','coordination_jobs','coordination_sources','receipts'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get('dynamic_'+table))db.exec(`CREATE TABLE dynamic_${table}(id TEXT PRIMARY KEY,body TEXT)`)
 put('coordination','c',{id:'c',groupId:'g',state:'active'})
 put('coordination_members','m',{id:'m',coordinationId:'c',taskId:'task',state:'fulfilled',command:{id:'cmd'},completionProof:{commandId:'done',eventId:'event',requirementRevision:1,contextRevision:0,controlRevision:1,runSequence:1}})
 put('tasks','task',{taskId:'task',status:'completed',control:'active',title:'title',request:large,completion:{commandId:'done',instructionIds:['m'],result:large},requirementRevision:1,contextRevision:0,controlRevision:1,runSequence:1,archivedAt:'archive'})
 put('executions','e',{executionId:'e',taskId:'task',status:'succeeded',drained:true,input:large,result:large})
 put('receipts','cmd',{id:'cmd',result:{task:{taskId:'task',requirementRevision:1,contextRevision:0,controlRevision:1,runSequence:1,dialogue:large}}})
 db.exec("INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks; DELETE FROM dynamic_tasks; INSERT INTO dynamic_archived_executions SELECT id,rowid,body FROM dynamic_executions; DELETE FROM dynamic_executions; INSERT INTO dynamic_archived_receipts SELECT id,rowid,body FROM dynamic_receipts; UPDATE dynamic_receipts SET body=json_object('archivedTaskId','task') WHERE id='cmd';")
 const captured=[];const observed={prepare(sql){const st=db.prepare(sql);return {get:(...a)=>st.get(...a),all:(...a)=>{const rows=st.all(...a);captured.push({sql,args:a,rows});return rows}}}}
 const model=observerWorkMetadata(observed,{groupId:'g'})
 assert.equal(model.tasks[0].status,'completed');assert.equal(model.tasks[0].completion.commandId,'done')
 assert.equal(model.executions[0].executionId,'e');assert.equal(model.receipts[0].result.task.taskId,'task')
 assert(!JSON.stringify(model).includes(large))
 assert(captured.every(entry=>entry.rows.every(row=>!String(row.body).includes(large))))
 const receiptQuery=captured.find(entry=>entry.sql.includes('LEFT JOIN dynamic_archived_receipts'))
 const plan=db.prepare('EXPLAIN QUERY PLAN '+receiptQuery.sql).all(...receiptQuery.args)
 assert(plan.some(row=>/SEARCH a USING INDEX/.test(row.detail)));assert(!plan.some(row=>/SCAN a/.test(row.detail)))
 db.exec("DELETE FROM dynamic_archived_receipts WHERE id='cmd'")
 assert.throws(()=>observerWorkMetadata(db,{groupId:'g'}),{code:'DYNAMIC_ARCHIVE_RECEIPT_MISSING'})
})


test('late archive schema installs hooks explicitly once while GET remains free of DDL',t=>{
 const {db,put,page}=fixture(t)
 for(const name of ['tasks','executions','wakes','notifications'])db.exec(`CREATE TABLE dynamic_archived_${name}(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,body TEXT)`)
 put('tasks','task',{taskId:'task',status:'completed',drained:true,archivedAt:'archive',request:'original'})
 const before=db.prepare('PRAGMA schema_version').get().schema_version
 assert.equal(page({collection:'tasks',archived:true,limit:1}).items[0].request,'original')
 assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,before)
 assert.equal(installObserverArchivePagination(db),true)
 const installed=db.prepare('PRAGMA schema_version').get().schema_version
 assert.equal(installObserverArchivePagination(db),true)
 assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,installed)
 db.exec('INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks; DELETE FROM dynamic_tasks;')
 assert.equal(page({collection:'tasks',archived:true,limit:1}).items[0].request,'original')
})


test('task state refresh and counts never read historical execution bodies after control indexing',t=>{
 const {db,put,page}=fixture(t,{archives:true})
 put('tasks','task',{taskId:'task',status:'active',control:'active',drained:true,lastDecision:{action:'wait'}})
 for(let n=0;n<100;n++)put('executions',`done-${n}`,{executionId:`done-${n}`,taskId:'task',status:'succeeded',drained:true,inputHistory:['large history '.repeat(1000)]})
 put('executions','pending',{executionId:'pending',taskId:'task',status:'succeeded',drained:false})
 assert.equal(db.prepare("SELECT state FROM observer_task_index WHERE id='task'").get().state,'running')
 put('executions','pending',{executionId:'pending',taskId:'task',status:'succeeded',drained:true})
 assert.equal(db.prepare("SELECT state FROM observer_task_index WHERE id='task'").get().state,'waiting')
 const plan=db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM observer_execution_index e WHERE e.task_id=? AND (e.state IN ('queued','running') OR e.drained=0)").all('task')
 assert(plan.some(row=>/COVERING INDEX observer_execution_state/.test(row.detail)))
 let forbiddenReads=0
 db.setAuthorizer((action,table,column)=>{if(action===constants.SQLITE_READ&&table==='dynamic_executions'&&column==='body'){forbiddenReads++;return constants.SQLITE_DENY}return constants.SQLITE_OK})
 try {
  db.exec("UPDATE dynamic_tasks SET body=json_set(body,'$.updatedAt','now') WHERE id='task'")
  put('wakes','wake',{taskId:'task',state:'acked'})
  const result=page({collection:'tasks',limit:1})
  assert.equal(result.items[0].executionCount,101);assert.equal(result.items[0].completedExecutionCount,101)
  assert.equal(forbiddenReads,0)
 } finally {db.setAuthorizer(null)}
 db.exec("INSERT INTO dynamic_archived_executions SELECT id,rowid,body FROM dynamic_executions; DELETE FROM dynamic_executions;")
 assert.equal(db.prepare('SELECT count(*) n FROM observer_execution_index WHERE drained=1').get().n,101)
 assert.equal(db.prepare("SELECT state FROM observer_task_index WHERE id='task'").get().state,'waiting')
 // Repeating an explicit migration must retain archive-aware delete hooks.
 installObserverPagination(db,{migrate:true})
 put('tasks','task',{taskId:'task',status:'completed',drained:true,archivedAt:'archive'})
 db.exec('INSERT INTO dynamic_archived_tasks SELECT id,rowid,body FROM dynamic_tasks; DELETE FROM dynamic_tasks;')
 assert.equal(Object.hasOwn(page({collection:'tasks',archived:true,limit:1}).items[0],'executionCount'),false)
 assert.equal(page({collection:'executions',taskId:'task',summary:true,limit:1}).total,101)
})

test('legacy execution index stays readable without DDL and explicit migration adds control metadata',t=>{
 const {db,put,page}=fixture(t)
 put('tasks','task',{taskId:'task',status:'active',control:'active',drained:true,lastDecision:{action:'wait'}})
 put('executions','execution',{executionId:'execution',taskId:'task',status:'succeeded',drained:false})
 for(const trigger of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all())if(trigger.sql.includes('drained')||trigger.sql.includes('observer_execution_index'))db.exec(`DROP TRIGGER ${trigger.name}`)
 db.exec('DROP INDEX observer_execution_state; ALTER TABLE observer_execution_index DROP COLUMN drained;')
 const version=db.prepare('PRAGMA schema_version').get().schema_version
 assert.equal(page({collection:'executions',taskId:'task',limit:1}).items[0].executionId,'execution')
 assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,version)
 assert(!db.prepare('PRAGMA table_info(observer_execution_index)').all().some(column=>column.name==='drained'))
 installObserverPagination(db,{migrate:true})
 assert.equal(db.prepare("SELECT drained FROM observer_execution_index WHERE id='execution'").get().drained,0)
 let forbiddenReads=0
 db.setAuthorizer((action,table,column)=>{if(action===constants.SQLITE_READ&&table==='dynamic_executions'&&column==='body'){forbiddenReads++;return constants.SQLITE_DENY}return constants.SQLITE_OK})
 try {db.exec("UPDATE dynamic_tasks SET body=json_set(body,'$.updatedAt','after-migration') WHERE id='task'");assert.equal(forbiddenReads,0)} finally {db.setAuthorizer(null)}
 assert.equal(db.prepare("SELECT state FROM observer_task_index WHERE id='task'").get().state,'running')
})


test('execution card page selects only its task/page and omits unrelated definition and old timing history',t=>{
 const {db,put}=fixture(t)
 const old=Array.from({length:300},(_,i)=>({leaseEpoch:1,state:'closed',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:01:00Z',unused:'x'.repeat(200)}))
 db.exec('BEGIN')
 for(let n=0;n<140;n++)put('executions',`e${n}`,{executionId:`e${n}`,sessionId:`s${n}`,taskId:n<40?'selected':'other',title:`执行${n}`,status:'running',drained:false,leaseEpoch:2,
  definition:{executionBackend:'claude-code',secretUnused:'large-definition'.repeat(1000)},result:{payload:{output:'large-result'.repeat(1000)}},timeline:{segments:[...old,{leaseEpoch:2,state:'running',startedAt:'2026-01-02T00:00:00Z'}]}})
 db.exec('COMMIT')
 let rows=0;const queries=[]
 const bounded={prepare(sql){queries.push(sql);const stmt=db.prepare(sql);return {get:(...args)=>stmt.get(...args),all:(...args)=>{const value=stmt.all(...args);if(sql.includes(' AS body'))rows+=value.length;return value}}}}
 const page=observerPage(bounded,{collection:'executions',taskId:'selected',summary:true,offset:10,limit:2},'fixture')
 assert.equal(page.total,40);assert.equal(rows,2);assert.deepEqual(page.items.map(row=>row.executionId),['e10','e11'])
 for(const row of page.items){assert.equal(row.definition.executionBackend,'claude-code');assert.equal(row.definition.secretUnused,undefined);assert.equal(row.result,undefined);assert.equal(row.timeline.segments.length,1);assert.equal(row.timeline.segments[0].leaseEpoch,2)}
 assert(Buffer.byteLength(JSON.stringify(page.items))<2000)
 assert(queries.some(sql=>sql.includes('observer_execution_index i WHERE i.task_id=?')&&sql.includes('LIMIT ? OFFSET ?')))
 // Full execution details retain the original result/definition/history contract.
 const detail=observerPage(bounded,{collection:'executions',taskId:'selected',offset:10,limit:1},'fixture').items[0]
 assert.equal(detail.timeline.segments.length,301);assert(detail.result.payload.output);assert(detail.definition.secretUnused)
})


test('execution card service returns timing and identity without constructing detail paths or querying other data',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-assistant/task-session-service.js',import.meta.url),'utf8')
 const fragment=source.slice(source.indexOf('  async function taskExecutions('),source.indexOf('  async function materializeSource('))
 const calls=[];const entry={executionId:'e',sessionId:'s',title:'中文标题',status:'running',drained:false,leaseEpoch:2,definition:{executionBackend:'claude-code'},timeline:{segments:[{leaseEpoch:2,state:'running',startedAt:'2026-01-02T00:00:00Z'}]}}
 const method=runInNewContext(`${fragment};taskExecutions`,{query:async(kind,args)=>{calls.push({kind,args});return {items:[entry],total:1,nextOffset:null}},executionSessionTitle,latestExecutionRoundTiming,executionBackend:e=>e.definition?.executionBackend??'dsh',taskFilePath(){throw new Error('summary must not construct detail paths')},taskSessionLogRoot(){throw new Error('summary must not read logs')}})
 const page=await method('only-this-task',{summary:true,offset:0,limit:10})
 assert.equal(calls.length,1);assert.equal(calls[0].kind,'observer.page');assert.equal(calls[0].args.taskId,'only-this-task');assert.equal(calls[0].args.limit,10)
 const row=page.executions[0];assert.equal(row.title,'中文标题');assert.equal(row.executionBackend,'claude-code');assert.equal(row.latestRoundTiming.startedAt,'2026-01-02T00:00:00Z');assert.equal(row.latestRoundTiming.active,true)
 for(const key of ['timeline','definition','result','document','logPath','workspaceDir','workingDirectory'])assert.equal(row[key],undefined)
})
