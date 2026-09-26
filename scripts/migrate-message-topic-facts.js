import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const [, , mode, path] = process.argv
if (!['--check', '--execute'].includes(mode) || !path || !isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) {
  console.error('用法: node scripts/migrate-message-topic-facts.js --check|--execute <absolute-db-path>')
  process.exitCode = 2
} else {
  const db = new DatabaseSync(path, { readOnly: mode === '--check' })
  let owner
  const auditTable = (connection, table) => {
    const hash=createHash('sha256');let count=0
    for(const row of connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {hash.update(JSON.stringify(row));hash.update('\n');count++}
    return {count,sha256:hash.digest('hex')}
  }
  try {
    if(mode==='--execute'){
      owner=new DatabaseSync(path+'.owner.sqlite')
      owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
    }
    const scalar = sql => Object.values(db.prepare(sql).get())[0]
    if (scalar('PRAGMA application_id') !== 0x44534845 || scalar('PRAGMA user_version') !== 4
      || scalar('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 4) throw new Error('MIGRATION_SOURCE_MISMATCH')
    if (scalar('PRAGMA integrity_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('MIGRATION_INTEGRITY_FAILED')
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_topic_facts'").get()) throw new Error('MIGRATION_TARGET_EXISTS')
    const unchangedTables=['message_runs','message_items','business_tasks','task_plan_stages','execution_runs','execution_effects','execution_approvals']
    const baseline=Object.fromEntries(unchangedTables.map(table=>[table,auditTable(db,table)]))
    const counts={unknownEffects:scalar("SELECT COUNT(*) FROM execution_effects WHERE state='unknown'"),pendingApprovals:scalar("SELECT COUNT(*) FROM execution_approvals WHERE decision='pending' AND revoked=0")}
    const topics = db.prepare('SELECT topic_id,body FROM message_topics ORDER BY rowid').all()
    let factCount = 0
    const seen = new Set()
    for (const row of topics) {
      const topic = JSON.parse(row.body)
      if (topic.topicId !== row.topic_id || !Array.isArray(topic.facts)) throw new Error('MIGRATION_TOPIC_INVALID')
      for (const fact of topic.facts) {
        if (typeof fact.id !== 'string' || !['active','invalidated','superseded','unresolved'].includes(fact.status)
          || !Array.isArray(fact.sourceRefs) || !fact.sourceRefs.length) throw new Error('MIGRATION_FACT_INVALID')
        for (const ref of fact.sourceRefs) {
          const evidence = db.prepare('SELECT body FROM message_runs WHERE source_key=? AND source_version=?').get(ref.sourceKey, ref.sourceVersion)
          const source = evidence ? JSON.parse(evidence.body) : null
          if (!source || source.conversationId !== topic.conversationId || typeof ref.text !== 'string' || !source.body.includes(ref.text)) throw new Error('MIGRATION_FACT_SOURCE_INVALID')
        }
        const key = JSON.stringify([row.topic_id, fact.id])
        if (seen.has(key)) throw new Error('MIGRATION_FACT_DUPLICATE')
        seen.add(key); factCount++
      }
    }
    if (mode === '--check') {
      console.log(JSON.stringify({ mode: 'check', path, fromVersion: 4, toVersion: 5, topics: topics.length, facts: factCount, ...counts,baseline,writable: false }))
    } else {
      db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;')
      let backupPath
      try {
        // 在线库不作为迁移对象；备份先于任何 schema 或内容改写。
        backupPath = `${path}.pre-topic-facts-v5-${randomUUID()}.sqlite`
        db.prepare('VACUUM INTO ?').run(backupPath)
        const backup=new DatabaseSync(backupPath,{readOnly:true})
        try {
          if (Object.values(backup.prepare('PRAGMA user_version').get())[0] !== 4
            || backup.prepare('SELECT COUNT(*) AS count FROM message_topics').get().count !== topics.length
            || Object.values(backup.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error('MIGRATION_BACKUP_INVALID')
          for(const table of unchangedTables)if(JSON.stringify(auditTable(backup,table))!==JSON.stringify(baseline[table]))throw new Error(`MIGRATION_BACKUP_MISMATCH:${table}`)
          for(const row of topics)if(backup.prepare('SELECT body FROM message_topics WHERE topic_id=?').get(row.topic_id)?.body!==row.body)throw new Error('MIGRATION_BACKUP_TOPIC_MISMATCH')
        } finally { backup.close() }
        db.exec('BEGIN IMMEDIATE')
        if (scalar('PRAGMA user_version') !== 4 || db.prepare('SELECT COUNT(*) AS count FROM message_topics').get().count !== topics.length) throw new Error('MIGRATION_SOURCE_CHANGED')
        const current=db.prepare('SELECT body FROM message_topics WHERE topic_id=?')
        for(const row of topics)if(current.get(row.topic_id)?.body!==row.body)throw new Error('MIGRATION_SOURCE_CHANGED')
        for(const table of unchangedTables)if(JSON.stringify(auditTable(db,table))!==JSON.stringify(baseline[table]))throw new Error(`MIGRATION_SOURCE_CHANGED:${table}`)
        db.exec(`CREATE TABLE message_topic_facts(fact_id TEXT NOT NULL,topic_id TEXT NOT NULL REFERENCES message_topics(topic_id),status TEXT NOT NULL CHECK(status IN ('active','invalidated','superseded','unresolved')),body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(topic_id,fact_id)) STRICT;
          CREATE INDEX message_topic_facts_topic_status ON message_topic_facts(topic_id,status);`)
        const insert = db.prepare('INSERT INTO message_topic_facts(fact_id,topic_id,status,body) VALUES(?,?,?,?)')
        const update = db.prepare('UPDATE message_topics SET body=? WHERE topic_id=?')
        for (const row of topics) {
          const topic = JSON.parse(row.body)
          for (const fact of topic.facts) insert.run(fact.id,row.topic_id,fact.status,JSON.stringify(fact))
          delete topic.facts
          topic.contextRevision = topic.contextRevision ?? 0
          update.run(JSON.stringify(topic),row.topic_id)
        }
        db.exec('PRAGMA user_version=5')
        db.prepare('UPDATE execution_meta SET schema_version=5 WHERE singleton=1').run()
        if (scalar('SELECT COUNT(*) FROM message_topic_facts') !== factCount || db.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error('MIGRATION_READBACK_FAILED')
        }
        for(const row of topics)for(const fact of JSON.parse(row.body).facts){
          const saved=db.prepare('SELECT status,body FROM message_topic_facts WHERE topic_id=? AND fact_id=?').get(row.topic_id,fact.id)
          if(saved?.status!==fact.status||saved.body!==JSON.stringify(fact))throw new Error('MIGRATION_FACT_READBACK_MISMATCH')
        }
        for(const table of unchangedTables)if(JSON.stringify(auditTable(db,table))!==JSON.stringify(baseline[table]))throw new Error(`MIGRATION_READBACK_MISMATCH:${table}`)
        db.exec('COMMIT')
      } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
      if (scalar('PRAGMA user_version') !== 5 || scalar('SELECT schema_version FROM execution_meta WHERE singleton=1') !== 5
        || scalar('SELECT COUNT(*) FROM message_topic_facts') !== factCount || scalar('PRAGMA integrity_check') !== 'ok'
        || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('MIGRATION_READBACK_FAILED')
      const reopened=new DatabaseSync(path,{readOnly:true})
      try {
        for(const table of unchangedTables)if(JSON.stringify(auditTable(reopened,table))!==JSON.stringify(baseline[table]))throw new Error(`MIGRATION_READBACK_MISMATCH:${table}`)
        for(const row of topics)for(const fact of JSON.parse(row.body).facts){
          const saved=reopened.prepare('SELECT status,body FROM message_topic_facts WHERE topic_id=? AND fact_id=?').get(row.topic_id,fact.id)
          if(saved?.status!==fact.status||saved.body!==JSON.stringify(fact))throw new Error('MIGRATION_FACT_READBACK_MISMATCH')
        }
      }finally{reopened.close()}
      console.log(JSON.stringify({ mode: 'execute', path, fromVersion: 4, toVersion: 5, topics: topics.length, facts: factCount, ...counts,baseline,backupPath }))
    }
  } finally { db.close();if(owner){try{owner.exec('ROLLBACK')}catch{}owner.close()} }
}
