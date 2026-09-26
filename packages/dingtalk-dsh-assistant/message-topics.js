import { createHash } from 'node:crypto'
const fail=code=>{throw Object.assign(new Error(code),{code})}
const str=(v,max=4096)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail('MESSAGE_TOPIC_INVALID');return v}
const encode=v=>JSON.stringify(v)
const hash=v=>createHash('sha256').update(encode(v)).digest('hex')
export function wholeTopicFactRevision(body, change) {
 return ['当前话题','整条条件'].includes(change.scope)
  && !/仅(?:对|针对|限|任务)|只(?:对|针对|限)|其他|其余|保持|保留|部分|不变|除.{0,20}外/u.test(body)
}
export function installMessageTopics(db){db.exec(`CREATE TABLE message_topics(topic_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
CREATE TABLE message_topic_bindings(unit_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES message_runs(run_id),topic_id TEXT NOT NULL REFERENCES message_topics(topic_id),source_key TEXT NOT NULL,source_version INTEGER NOT NULL) STRICT;
CREATE TABLE message_topic_facts(fact_id TEXT NOT NULL,topic_id TEXT NOT NULL REFERENCES message_topics(topic_id),status TEXT NOT NULL CHECK(status IN ('active','invalidated','superseded','unresolved')),body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(topic_id,fact_id)) STRICT;
CREATE INDEX message_topics_conversation ON message_topics(conversation_id);
CREATE INDEX message_topic_sources ON message_topic_bindings(source_key);
CREATE INDEX message_topic_facts_topic_status ON message_topic_facts(topic_id,status);`)}
export function validateMessageTopics(db){db.prepare('SELECT topic_id,conversation_id,body FROM message_topics LIMIT 0').all();db.prepare('SELECT unit_id,run_id,topic_id,source_key,source_version FROM message_topic_bindings LIMIT 0').all();db.prepare('SELECT fact_id,topic_id,status,body FROM message_topic_facts LIMIT 0').all()}
function topicView(db,body){
 const topic=JSON.parse(body), rows=db.prepare("SELECT body FROM message_topic_facts WHERE topic_id=? AND status='active' ORDER BY rowid LIMIT 257").all(topic.topicId)
 topic.facts=rows.slice(0,256).map(row=>JSON.parse(row.body));topic.hasMoreFacts=rows.length>256
 return topic
}
export function invalidateMessageSourceTopics(db,sourceKey,now){
 for(const row of db.prepare('SELECT DISTINCT t.body FROM message_topics t JOIN message_topic_bindings b ON b.topic_id=t.topic_id WHERE b.source_key=?').all(sourceKey)){
  const topic=JSON.parse(row.body);topic.inputRevision=(topic.inputRevision??0)+1;topic.updatedAt=now
  let changed=false
  for(const entry of db.prepare("SELECT fact_id,body FROM message_topic_facts WHERE topic_id=? AND status='active'").all(topic.topicId)){
   const fact=JSON.parse(entry.body)
   if(fact.sourceRefs.some(ref=>ref.sourceKey===sourceKey)){db.prepare("UPDATE message_topic_facts SET status='invalidated',body=? WHERE topic_id=? AND fact_id=?").run(encode({...fact,status:'invalidated',invalidatedAt:now}),topic.topicId,entry.fact_id);changed=true}
  }
  if(changed)topic.contextRevision=(topic.contextRevision??0)+1
  db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(encode(topic),topic.topicId)
 }
}
export function unbindMessageUnit(db,unitId,now){
 const row=db.prepare('SELECT topic_id FROM message_topic_bindings WHERE unit_id=?').get(unitId)
 if(!row)return
 const topicRow=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(row.topic_id)
 if(topicRow){const topic=JSON.parse(topicRow.body);topic.inputRevision=(topic.inputRevision??0)+1;topic.contextRevision=(topic.contextRevision??0)+1;topic.updatedAt=now;db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(encode(topic),topic.topicId)}
 db.prepare('DELETE FROM message_topic_bindings WHERE unit_id=?').run(unitId)
}
export function bindQuietTopic(db, { runId, topicId, evidenceSourceKey, quoteMessageId }) {
 for(const value of [runId,topicId,evidenceSourceKey,quoteMessageId])str(value)
 const row=db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(runId)
 if(!row)fail('MESSAGE_RUN_NOT_FOUND')
 const run=JSON.parse(row.body)
 if(run.status!=='settled'||run.reason!=='message_quiet'||!run.context?.quoteRefs?.some(ref=>ref.messageId===quoteMessageId))fail('MESSAGE_QUIET_TOPIC_FORBIDDEN')
 const topicRow=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(topicId)
 if(!topicRow)fail('MESSAGE_QUIET_TOPIC_NOT_FOUND')
 const topic=JSON.parse(topicRow.body)
 if(topic.conversationId!==run.conversationId||evidenceSourceKey===run.sourceKey)fail('MESSAGE_QUIET_TOPIC_SCOPE_MISMATCH')
 const evidence=db.prepare(`SELECT 1 FROM message_topic_bindings b JOIN message_runs r ON r.run_id=b.run_id
  WHERE b.source_key=? AND b.topic_id=? AND json_extract(r.body,'$.conversationId')=? LIMIT 1`).get(evidenceSourceKey,topicId,run.conversationId)
 if(!evidence)fail('MESSAGE_QUIET_TOPIC_EVIDENCE_MISSING')
 const unitId=`quiet:${run.runId}`
 const existing=db.prepare('SELECT topic_id FROM message_topic_bindings WHERE unit_id=?').get(unitId)
 if(existing&&existing.topic_id!==topicId)fail('MESSAGE_TOPIC_BINDING_CONFLICT')
 if(!existing){db.prepare('INSERT INTO message_topic_bindings VALUES(?,?,?,?,?)').run(unitId,run.runId,topicId,run.sourceKey,run.sourceVersion);topic.contextRevision=(topic.contextRevision??0)+1;topic.updatedAt=new Date().toISOString();db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?').run(encode(topic),topicId)}
 return { topicId, unitId, bound: !existing }
}
export function reduceMessageTopic(db,{kind,args:a},ctx){
 if(kind!=='message.topic.upsert')return null
 for(const key of ['topicId','conversationId','sourceRunId','unitId','title'])str(a[key])
 const row=db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(a.sourceRunId),unit=db.prepare("SELECT body FROM message_items WHERE item_id=? AND run_id=? AND kind='unit'").get('unit:'+a.unitId,a.sourceRunId)
 if(!row||!unit)fail('MESSAGE_TOPIC_SOURCE_REQUIRED')
 const source=JSON.parse(row.body),u=JSON.parse(unit.body)
 if(source.conversationId!==a.conversationId||source.status==='superseded'||u.status==='superseded')fail('MESSAGE_TOPIC_SCOPE_MISMATCH')
 const previous=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(a.topicId),topic=previous?JSON.parse(previous.body):{topicId:a.topicId,conversationId:a.conversationId,title:a.title,actorId:source.actorId,revision:0,contextRevision:0,createdAt:ctx.now}
 if(topic.conversationId!==a.conversationId)fail('MESSAGE_TOPIC_SCOPE_MISMATCH')
 if(a.expectedRevision!==undefined&&a.expectedRevision!==topic.revision)fail('MESSAGE_TOPIC_STALE')
 if(!Array.isArray(a.facts)||a.facts.length>32)fail('MESSAGE_TOPIC_INVALID')
 if(!previous)db.prepare('INSERT INTO message_topics VALUES(?,?,?)').run(topic.topicId,topic.conversationId,encode(topic))
 for(const fact of a.facts){
  str(fact.text);if(!['constraint','fact'].includes(fact.kind)||!Array.isArray(fact.sourceRefs)||!fact.sourceRefs.length||fact.sourceRefs.length>16)fail('MESSAGE_TOPIC_EVIDENCE_REQUIRED')
  for(const ref of fact.sourceRefs){str(ref.sourceKey);str(ref.text);if(!Number.isSafeInteger(ref.sourceVersion)||ref.sourceVersion<1)fail('MESSAGE_TOPIC_EVIDENCE_REQUIRED');const evidence=db.prepare('SELECT body FROM message_runs WHERE source_key=? AND source_version=?').get(ref.sourceKey,ref.sourceVersion);if(!evidence)fail('MESSAGE_TOPIC_EVIDENCE_REQUIRED');const e=JSON.parse(evidence.body);if(e.conversationId!==a.conversationId||!e.body.includes(ref.text))fail('MESSAGE_TOPIC_EVIDENCE_INVALID')}
  const id=hash([fact.kind,fact.text,fact.sourceRefs]);if(!db.prepare('SELECT 1 FROM message_topic_facts WHERE topic_id=? AND fact_id=?').get(topic.topicId,id)){
   db.prepare("INSERT INTO message_topic_facts(fact_id,topic_id,status,body) VALUES(?,?,'active',?)").run(id,topic.topicId,encode({...fact,id,status:'active',actorId:source.actorId,sourceRunId:source.runId,createdAt:ctx.now}))
   topic.contextRevision=(topic.contextRevision??0)+1
  }
 }
 const bound=db.prepare('SELECT topic_id FROM message_topic_bindings WHERE unit_id=?').get(a.unitId)
 if(bound&&bound.topic_id!==a.topicId)fail('MESSAGE_TOPIC_BINDING_CONFLICT')
 topic.revision++;topic.inputRevision=(topic.inputRevision??0)+(!bound?1:0);topic.contextRevision=(topic.contextRevision??0)+(!bound?1:0);topic.updatedAt=ctx.now
 db.prepare('INSERT INTO message_topics VALUES(?,?,?) ON CONFLICT(topic_id) DO UPDATE SET body=excluded.body').run(topic.topicId,topic.conversationId,encode(topic))
 if(!bound)db.prepare('INSERT INTO message_topic_bindings VALUES(?,?,?,?,?)').run(a.unitId,a.sourceRunId,a.topicId,source.sourceKey,source.sourceVersion)
 u.topicId=topic.topicId;db.prepare('UPDATE message_items SET body=? WHERE item_id=?').run(encode(u),'unit:'+a.unitId)
 return {result:{topic:topicView(db,encode(topic))}}
}
export function queryMessageTopics(db,a){
 if(a.kind==='message.topic.intents'){
  const limit=a.limit??50,before=a.beforeSequenceId??Number.MAX_SAFE_INTEGER
  if(!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_TOPIC_INVALID')
  return db.prepare("SELECT rowid AS seq,body FROM message_items WHERE kind='node' AND json_extract(body,'$.nodeId')='IB' AND json_extract(body,'$.input.topicId')=? AND rowid<? ORDER BY rowid DESC LIMIT ?")
   .all(str(a.topicId),before,limit).map(row=>{const n=JSON.parse(row.body);return {intentRunId:n.input?.intentRunId??null,status:n.status,createdAt:n.createdAt,sourceRunIds:[...new Set((n.input?.units??[]).map(unit=>unit.runId))],carrierRunId:n.runId,nodeRunId:n.nodeRunId,sequenceId:row.seq}})
 }
 if(a.kind==='message.topic'){const row=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(str(a.topicId));return row?topicView(db,row.body):null}
 if(a.kind==='message.topic.facts'){
  const topicId=str(a.topicId),limit=a.limit??100,cursor=a.cursor??0,status=a.status??'active'
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(cursor)||cursor<0||!['active','invalidated','superseded','unresolved','all'].includes(status))fail('MESSAGE_TOPIC_INVALID')
  const topic=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(topicId);if(!topic)return null
  const where=status==='all'?'':' AND status=?',params=status==='all'?[topicId]:[topicId,status]
  const rows=db.prepare(`SELECT rowid AS seq,body FROM message_topic_facts WHERE topic_id=?${where} AND rowid>? ORDER BY rowid LIMIT ?`).all(...params,cursor,limit+1)
  return {facts:rows.slice(0,limit).map(row=>({...JSON.parse(row.body),sequenceId:row.seq})),nextCursor:rows.length>limit?rows[limit-1].seq:null,total:db.prepare(`SELECT COUNT(*) AS count FROM message_topic_facts WHERE topic_id=?${where}`).get(...params).count,contextRevision:JSON.parse(topic.body).contextRevision??0}
 }
 if(a.kind==='message.topics'){const limit=a.limit??30,before=a.beforeTopicRowId??Number.MAX_SAFE_INTEGER;if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(before)||before<1)fail('MESSAGE_TOPIC_INVALID');return db.prepare('SELECT rowid AS seq,body FROM message_topics WHERE conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(str(a.conversationId),before,limit).map(r=>({...topicView(db,r.body),sequenceId:r.seq}))}
 if(a.kind==='message.topic.source')return db.prepare('SELECT DISTINCT t.body FROM message_topics t JOIN message_topic_bindings b ON b.topic_id=t.topic_id WHERE b.source_key=?').all(str(a.sourceKey)).map(r=>topicView(db,r.body))
 if(a.kind==='message.topic.bindings')return db.prepare('SELECT b.source_key,b.source_version,b.unit_id,t.body FROM message_topic_bindings b JOIN message_topics t ON t.topic_id=b.topic_id WHERE t.conversation_id=? ORDER BY b.rowid').all(str(a.conversationId)).map(r=>({sourceKey:r.source_key,sourceVersion:r.source_version,unitId:r.unit_id,topic:topicView(db,r.body)}))
 if(a.kind==='message.topic.sources'){const limit=a.limit??100,cursor=a.cursor??0;if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(cursor)||cursor<0)fail('MESSAGE_TOPIC_INVALID');if(a.cursor===undefined&&a.limit===undefined)return db.prepare('SELECT DISTINCT source_key FROM message_topic_bindings WHERE topic_id=?').all(str(a.topicId)).map(r=>r.source_key);const rows=db.prepare('SELECT rowid AS seq,source_key FROM message_topic_bindings WHERE topic_id=? AND rowid>? ORDER BY rowid LIMIT ?').all(str(a.topicId),cursor,limit+1);return {sourceKeys:[...new Set(rows.slice(0,limit).map(r=>r.source_key))],nextCursor:rows.length>limit?rows[limit-1].seq:null}}
 if(a.kind==='message.topic.pending')return db.prepare(`SELECT t.body FROM message_topics t WHERE t.conversation_id=? AND EXISTS (
   SELECT 1 FROM message_topic_bindings b JOIN message_items i ON i.item_id='unit:'||b.unit_id
   JOIN message_runs r ON r.run_id=b.run_id JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
   WHERE b.topic_id=t.topic_id AND json_extract(i.body,'$.status')='pending'
 ) ORDER BY t.rowid`).all(str(a.conversationId)).map(r=>topicView(db,r.body))
 if(a.kind==='message.topic.units')return db.prepare(`SELECT i.body AS unit,r.body AS run FROM message_topic_bindings b
   JOIN message_items i ON i.item_id='unit:'||b.unit_id JOIN message_runs r ON r.run_id=b.run_id
   JOIN message_sources s ON s.source_key=r.source_key AND s.current_version=COALESCE(json_extract(r.body,'$.validSourceVersion'),r.source_version)
   WHERE b.topic_id=? AND json_extract(i.body,'$.status')='pending' ORDER BY r.rowid,i.rowid`).all(str(a.topicId)).map(row=>({unit:JSON.parse(row.unit),run:JSON.parse(row.run)}))
 return undefined
}
