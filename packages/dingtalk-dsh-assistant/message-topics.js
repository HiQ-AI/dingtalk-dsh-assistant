import { createHash } from 'node:crypto'
const fail=code=>{throw Object.assign(new Error(code),{code})}
const str=(v,max=4096)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail('MESSAGE_TOPIC_INVALID');return v}
const encode=v=>JSON.stringify(v)
const hash=v=>createHash('sha256').update(encode(v)).digest('hex')
export function installMessageTopics(db){db.exec(`CREATE TABLE message_topics(topic_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body))) STRICT;
CREATE TABLE message_topic_bindings(unit_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES message_runs(run_id),topic_id TEXT NOT NULL REFERENCES message_topics(topic_id),source_key TEXT NOT NULL,source_version INTEGER NOT NULL) STRICT;
CREATE INDEX message_topics_conversation ON message_topics(conversation_id);
CREATE INDEX message_topic_sources ON message_topic_bindings(source_key);`)}
export function validateMessageTopics(db){db.prepare('SELECT topic_id,conversation_id,body FROM message_topics LIMIT 0').all();db.prepare('SELECT unit_id,run_id,topic_id,source_key,source_version FROM message_topic_bindings LIMIT 0').all()}
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
 if(!existing)db.prepare('INSERT INTO message_topic_bindings VALUES(?,?,?,?,?)').run(unitId,run.runId,topicId,run.sourceKey,run.sourceVersion)
 return { topicId, unitId, bound: !existing }
}
export function reduceMessageTopic(db,{kind,args:a},ctx){
 if(kind!=='message.topic.upsert')return null
 for(const key of ['topicId','conversationId','sourceRunId','unitId','title'])str(a[key])
 const row=db.prepare('SELECT body FROM message_runs WHERE run_id=?').get(a.sourceRunId),unit=db.prepare("SELECT body FROM message_items WHERE item_id=? AND run_id=? AND kind='unit'").get('unit:'+a.unitId,a.sourceRunId)
 if(!row||!unit)fail('MESSAGE_TOPIC_SOURCE_REQUIRED')
 const source=JSON.parse(row.body),u=JSON.parse(unit.body)
 if(source.conversationId!==a.conversationId||source.status==='superseded'||u.status==='superseded')fail('MESSAGE_TOPIC_SCOPE_MISMATCH')
 const previous=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(a.topicId),topic=previous?JSON.parse(previous.body):{topicId:a.topicId,conversationId:a.conversationId,title:a.title,actorId:source.actorId,revision:0,facts:[],createdAt:ctx.now}
 if(topic.conversationId!==a.conversationId)fail('MESSAGE_TOPIC_SCOPE_MISMATCH')
 if(a.expectedRevision!==undefined&&a.expectedRevision!==topic.revision)fail('MESSAGE_TOPIC_STALE')
 if(!Array.isArray(a.facts)||a.facts.length>32)fail('MESSAGE_TOPIC_INVALID')
 for(const fact of a.facts){
  str(fact.text);if(!['constraint','fact'].includes(fact.kind)||!Array.isArray(fact.sourceRefs)||!fact.sourceRefs.length||fact.sourceRefs.length>16)fail('MESSAGE_TOPIC_EVIDENCE_REQUIRED')
  for(const ref of fact.sourceRefs){str(ref.sourceKey);str(ref.text);if(!Number.isSafeInteger(ref.sourceVersion)||ref.sourceVersion<1)fail('MESSAGE_TOPIC_EVIDENCE_REQUIRED');const evidence=db.prepare('SELECT body FROM message_runs WHERE source_key=? AND source_version=?').get(ref.sourceKey,ref.sourceVersion);if(!evidence)fail('MESSAGE_TOPIC_EVIDENCE_REQUIRED');const e=JSON.parse(evidence.body);if(e.conversationId!==a.conversationId||!e.body.includes(ref.text))fail('MESSAGE_TOPIC_EVIDENCE_INVALID')}
  const id=hash([fact.kind,fact.text,fact.sourceRefs]);if(!topic.facts.some(f=>f.id===id))topic.facts.push({...fact,id,actorId:source.actorId,sourceRunId:source.runId,createdAt:ctx.now})
 }
 if(topic.facts.length>256)fail('MESSAGE_TOPIC_CAPACITY')
 const bound=db.prepare('SELECT topic_id FROM message_topic_bindings WHERE unit_id=?').get(a.unitId)
 if(bound&&bound.topic_id!==a.topicId)fail('MESSAGE_TOPIC_BINDING_CONFLICT')
 topic.revision++;topic.updatedAt=ctx.now
 db.prepare('INSERT INTO message_topics VALUES(?,?,?) ON CONFLICT(topic_id) DO UPDATE SET body=excluded.body').run(topic.topicId,topic.conversationId,encode(topic))
 if(!bound)db.prepare('INSERT INTO message_topic_bindings VALUES(?,?,?,?,?)').run(a.unitId,a.sourceRunId,a.topicId,source.sourceKey,source.sourceVersion)
 u.topicId=topic.topicId;db.prepare('UPDATE message_items SET body=? WHERE item_id=?').run(encode(u),'unit:'+a.unitId)
 return {result:{topic}}
}
export function queryMessageTopics(db,a){
 if(a.kind==='message.topic'){const row=db.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(str(a.topicId));return row?JSON.parse(row.body):null}
 if(a.kind==='message.topics'){const limit=a.limit??30;if(!Number.isSafeInteger(limit)||limit<1||limit>200)fail('MESSAGE_TOPIC_INVALID');return db.prepare('SELECT body FROM message_topics WHERE conversation_id=? ORDER BY rowid DESC LIMIT ?').all(str(a.conversationId),limit).map(r=>JSON.parse(r.body))}
 if(a.kind==='message.topic.source')return db.prepare('SELECT DISTINCT t.body FROM message_topics t JOIN message_topic_bindings b ON b.topic_id=t.topic_id WHERE b.source_key=?').all(str(a.sourceKey)).map(r=>JSON.parse(r.body))
 if(a.kind==='message.topic.bindings')return db.prepare('SELECT b.source_key,b.source_version,b.unit_id,t.body FROM message_topic_bindings b JOIN message_topics t ON t.topic_id=b.topic_id WHERE t.conversation_id=? ORDER BY b.rowid').all(str(a.conversationId)).map(r=>({sourceKey:r.source_key,sourceVersion:r.source_version,unitId:r.unit_id,topic:JSON.parse(r.body)}))
 if(a.kind==='message.topic.sources')return db.prepare('SELECT DISTINCT source_key FROM message_topic_bindings WHERE topic_id=?').all(str(a.topicId)).map(r=>r.source_key)
 return undefined
}
