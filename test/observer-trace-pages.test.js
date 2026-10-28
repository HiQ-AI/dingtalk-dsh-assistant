import {describeMessageTraceItem} from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import {queryMessageTopics} from '../packages/dingtalk-dsh-assistant/message-topics.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {installObserverTracePages,observerTracePage} from '../packages/dingtalk-dsh-assistant/observer-trace-pages.js'
test('trace selects indexed IDs before fetching event bodies, including shared intents without duplicates',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)')
 installObserverTracePages(db,{migrate:true})
 const putRun=db.prepare('INSERT INTO message_runs VALUES(?,?)'),put=db.prepare('INSERT INTO message_items VALUES(?,?,?,?)')
 putRun.run('r',JSON.stringify({runId:'r',createdAt:'same',coordinatorConsumed:{turnId:'turn'}}));putRun.run('other',JSON.stringify({runId:'other'}))
 db.exec('BEGIN')
 for(let i=0;i<1000;i++)put.run(`node:n${String(i).padStart(4,'0')}`,'r','node',JSON.stringify({runId:'r',nodeRunId:`n${String(i).padStart(4,'0')}`,createdAt:'same',input:{large:'payload'}}))
 put.run('node:shared','other','node',JSON.stringify({runId:'other',nodeRunId:'shared',nodeId:'IB',createdAt:'same',input:{units:[{runId:'r'},{runId:'r'}]}}))
 db.exec('COMMIT')
 let payloadReads=0;const observed={prepare(sql){const stmt=db.prepare(sql);return {get:(...args)=>{if(sql==='SELECT body FROM message_items WHERE item_id=?')payloadReads++;return stmt.get(...args)},all:(...args)=>stmt.all(...args)}}}
 const page=observerTracePage(observed,{runId:'r',offset:10,limit:10})
 assert.equal(page.total,1002);assert.equal(page.data.nodes.length,10);assert.equal(payloadReads,10)
 const last=observerTracePage(observed,{runId:'r',offset:1000,limit:10,revision:page.revision})
 assert.equal(last.total,1002);assert.equal(last.nextCursor,null)
 assert.equal(last.data.nodes.filter(item=>item.nodeRunId==='shared').length,1)
 put.run('command:c','r','command',JSON.stringify({id:'c',createdAt:'earlier'}))
 assert.throws(()=>observerTracePage(observed,{runId:'r',offset:20,limit:10,revision:page.revision}),{code:'OBSERVER_PAGE_STALE'})
 const plan=db.prepare('EXPLAIN QUERY PLAN SELECT item_id FROM observer_trace_index WHERE trace_run_id=? ORDER BY sort_key,id LIMIT 10').all('r')
 assert(plan.some(item=>item.detail.includes('observer_trace_page')));assert(!plan.some(item=>item.detail.includes('TEMP B-TREE')))
})


test('legacy topic context sorts narrow metadata before loading only the selected current source bodies',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec(`CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,source_key TEXT,source_version INTEGER,body TEXT);
 CREATE TABLE message_sources(source_key TEXT PRIMARY KEY,current_version INTEGER);
 CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT);
 CREATE TABLE message_topic_bindings(unit_id TEXT PRIMARY KEY,run_id TEXT,topic_id TEXT,source_key TEXT,source_version INTEGER);
 CREATE TABLE message_topic_facts(fact_id TEXT,topic_id TEXT,status TEXT,body TEXT);
 CREATE TABLE message_topics(topic_id TEXT PRIMARY KEY,conversation_id TEXT,body TEXT);`)
 installObserverTracePages(db,{migrate:true})
 const run=db.prepare('INSERT INTO message_runs VALUES(?,?,?,?)'),source=db.prepare('INSERT INTO message_sources VALUES(?,?)'),bind=db.prepare('INSERT INTO message_topic_bindings VALUES(?,?,?,?,?)')
 db.exec('BEGIN')
 for(let i=0;i<1000;i++){
  const id=String(i).padStart(4,'0');run.run('r'+id,'s'+id,1,JSON.stringify({body:'Payload '+id,createdAt:'same',context:{sourceMessageId:'m'+id}}));source.run('s'+id,1);bind.run('u'+id,'r'+id,'topic','s'+id,1)
 }
 db.exec('COMMIT')
 let bodyRows=0;const statements=[]
 const observed={prepare(sql){statements.push(sql);const stmt=db.prepare(sql);return {get:(...args)=>stmt.get(...args),all:(...args)=>{const rows=stmt.all(...args);if(sql.includes(' AS body'))bodyRows+=rows.length;return rows}}}}
 const result=queryMessageTopics(observed,{kind:'message.topic.context-page',topicId:'topic',offset:510,limit:10})
 assert.equal(result.total,1000);assert.equal(result.messages.length,10);assert.equal(bodyRows,10);assert.equal(result.messages[0].messageId,'m0510')
 assert(statements.some(sql=>sql.includes('selected AS MATERIALIZED')))
 // Facts may reference evidence outside bindings; deduplicate and update on invalidation.
 db.prepare('INSERT INTO message_topic_facts VALUES(?,?,?,?)').run('f','other','active',JSON.stringify({sourceRefs:[{sourceKey:'s0510',text:'large evidence'}]}))
 assert.equal(queryMessageTopics(db,{kind:'message.topic.context-page',topicId:'other',limit:1}).total,1)
 db.exec("UPDATE message_topic_facts SET status='invalidated' WHERE fact_id='f'")
 assert.equal(queryMessageTopics(db,{kind:'message.topic.context-page',topicId:'other',limit:1}).total,0)
 run.run('r0510v2','s0510',2,JSON.stringify({body:'Current version',createdAt:'same',context:{sourceMessageId:'m0510'}}));db.prepare('UPDATE message_sources SET current_version=2 WHERE source_key=?').run('s0510')
 assert.equal(queryMessageTopics(db,{kind:'message.topic.context-page',topicId:'topic',offset:510,limit:1}).messages[0].text,'Current version')
 assert.throws(()=>queryMessageTopics(observed,{kind:'message.topic.context-page',topicId:'topic',offset:520,limit:10,revision:result.pageRevision}),{code:'OBSERVER_PAGE_STALE'})
})


function coordinatorFixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close())
 db.exec('CREATE TABLE message_runs(run_id TEXT PRIMARY KEY,body TEXT);CREATE TABLE message_items(item_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,body TEXT)')
 installObserverTracePages(db,{migrate:true})
 db.prepare('INSERT INTO message_runs VALUES(?,?)').run('r',JSON.stringify({runId:'r',createdAt:'same',coordinatorConsumed:{turnId:'turn'}}))
 const put=(id,status)=>db.prepare('INSERT INTO message_items VALUES(?,?,?,?)').run('unit:'+id,'r','unit',JSON.stringify({id,status,goalText:`Evidence ${id}`}))
 return {db,put}
}

test('coordinator filters superseded units before LIMIT so the 101st accepted unit remains evidence',t=>{
 const {db,put}=coordinatorFixture(t)
 for(let i=0;i<100;i++)put('old'+i,'superseded')
 put('valid','accepted')
 const page=observerTracePage(db,{runId:'r'})
 assert.equal(page.total,1);assert.equal(page.nextCursor,null);assert.deepEqual(page.data.units.map(item=>item.id),['valid'])
 assert.deepEqual(page.data.coordinatorUnits,{cursor:0,limit:100,total:1,returned:1,nextCursor:null,complete:true})
 const summary=describeMessageTraceItem({kind:'coordinator',output:{units:page.data.units.map(unit=>({...unit,unitId:unit.id}))}})
 assert.equal(summary.rows.length,1);assert.equal(summary.rows[0].value,'Evidence valid')
})

test('more than 100 active coordinator units have independent bounded continuation and stale protection',t=>{
 const {db,put}=coordinatorFixture(t)
 for(let i=0;i<100;i++)put('old'+i,'superseded')
 for(let i=0;i<125;i++)put('valid'+i,'accepted')
 let maxRows=0;const sql=[]
 const observed={prepare(query){sql.push(query);const stmt=db.prepare(query);return {get:(...args)=>stmt.get(...args),all:(...args)=>{const rows=stmt.all(...args);if(query.includes("kind='unit'"))maxRows=Math.max(maxRows,rows.length);return rows}}}}
 const first=observerTracePage(observed,{runId:'r'})
 assert.equal(first.nextCursor,null);assert.equal(first.data.units.length,100);assert.equal(first.data.coordinatorUnits.total,125)
 assert.equal(first.data.coordinatorUnits.complete,false);assert(first.data.coordinatorUnits.nextCursor)
 assert.throws(()=>observerTracePage(observed,{runId:'r',unitCursor:first.data.coordinatorUnits.nextCursor}),{code:'OBSERVER_PAGE_STALE'})
 const second=observerTracePage(observed,{runId:'r',unitCursor:first.data.coordinatorUnits.nextCursor,revision:first.revision})
 assert.equal(second.data.units.length,25);assert.equal(second.data.coordinatorUnits.nextCursor,null)
 assert.equal(new Set([...first.data.units,...second.data.units].map(unit=>unit.id)).size,125)
 assert.equal(maxRows,101);assert(sql.some(query=>query.includes("coalesce(json_extract(body,'$.status'),'')!='superseded'")&&query.includes('LIMIT 101')))
 put('new','accepted')
 assert.throws(()=>observerTracePage(observed,{runId:'r',unitCursor:first.data.coordinatorUnits.nextCursor,revision:first.revision}),{code:'OBSERVER_PAGE_STALE'})
 assert.throws(()=>observerTracePage(db,{runId:'r',unitCursor:-1}),{code:'MESSAGE_INVALID_LIMIT'})
})
