import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{verifyNoticeEvidence,assertNoticeMaintenance}from'../docs/acceptance/topic-context-completeness/scripts/recover-notification-readback.mjs';
const n={id:'notice',runId:'run',leaseEpoch:1,status:'acknowledged',ack:{result:{openTaskId:'task'}},payload:{conversationId:'group',sourceMessageId:'source',text:'内容 `Code.java`'}};
const c={notificationId:'notice',runId:'run',leaseEpoch:1,openTaskId:'task',conversationId:'group',sourceMessageId:'source',messageId:'msg',proofObservedAt:'2026-01-01T00:00:00Z',initialRevision:42,expectedNoticeDigest:createHash('sha256').update(JSON.stringify(n)).digest('hex')};
const status={success:true,openTaskId:'task',result:{sendStatus:'SUCCESS'},messageRef:{openMessageId:'msg',openConversationId:'group'}};
const m={complete:true,hasMore:false,failedCount:0,messages:[{messageId:'msg',conversationId:'group',quotedMessage:{messageId:'source'},text:'内容 **Code.java**'}]};
test('独立status+message+正文+引用绑定；原生完成后可重复核验',()=>{const e=verifyNoticeEvidence(n,c,status,m);assert.equal(e.messageId,'msg');assert.deepEqual(verifyNoticeEvidence({...n,status:'delivered',evidence:e},c,status,m),e)})
test('错误消息/群/引用/正文/ACK/快照及未完整回读拒绝',()=>{for(const modify of [v=>v.messages[0].messageId='other',v=>v.messages[0].conversationId='other',v=>v.messages[0].quotedMessage.messageId='other',v=>v.messages[0].text='内容 Changed.java',v=>v.complete=false]){const x=structuredClone(m);modify(x);assert.throws(()=>verifyNoticeEvidence(n,c,status,x),/NOTICE_/)}assert.throws(()=>verifyNoticeEvidence({...n,leaseEpoch:2},c,status,m),/NOTICE_/);assert.throws(()=>verifyNoticeEvidence({...n,ack:{result:{openTaskId:'other'}}},c,status,m),/NOTICE_/);assert.throws(()=>verifyNoticeEvidence({...n,extra:true},c,status,m),/NOTICE_CAS_CHANGED/)})
test('唯一busy与精确维护CAS；其他活动不能收口',()=>{const s={active:true,phase:'draining',revision:43,maintenanceId:'maint',busy:{nodes:0,owners:0,effects:0,messages:1}},record={maintenanceId:'maint',maintenanceRevision:43};assertNoticeMaintenance(s,c,record,n);for(const k of ['nodes','owners','effects','messages']){const x=structuredClone(s);x.busy[k]++;assert.throws(()=>assertNoticeMaintenance(x,c,record,n),/NOTICE_/)}assert.throws(()=>assertNoticeMaintenance({...s,revision:44},c,record,n),/NOTICE_/);assertNoticeMaintenance({...s,busy:{nodes:0,owners:0,effects:0,messages:0}},c,record,{...n,status:'delivered'})})

test('半成品原样保留，选择全新attempt；完整manifest重用且多份拒绝',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile}=await import('node:fs/promises'),{resolve,join}=await import('node:path')
 const {selectNoticeBackup}=await import('../docs/acceptance/topic-context-completeness/scripts/recover-notification-readback.mjs')
 const dir=await mkdtemp(resolve('docs/tmp/notice-backup-test-'))
 assert.deepEqual(await selectNoticeBackup(dir),{backupRoot:join(dir,'backup'),complete:false})
 await mkdir(join(dir,'backup'));await writeFile(join(dir,'backup','partial'),'original')
 const next=await selectNoticeBackup(dir);assert.equal(next.backupRoot,join(dir,'backup-attempt-001'));assert.equal(next.complete,false)
 await mkdir(next.backupRoot);await writeFile(join(next.backupRoot,'manifest.json'),'invalid manifest remains for verifier')
 assert.deepEqual(await selectNoticeBackup(dir),{backupRoot:next.backupRoot,complete:true})
 assert.equal(await readFile(join(dir,'backup','partial'),'utf8'),'original')
 await writeFile(join(dir,'backup','manifest.json'),'second');await assert.rejects(selectNoticeBackup(dir),/NOTICE_BACKUP_AMBIGUOUS/)
})
test('重复恢复追加证据，首次原生receipt不被alreadyDelivered覆盖',async()=>{
 const {mkdtemp,readFile,readdir}=await import('node:fs/promises'),{resolve}=await import('node:path')
 const {appendNoticeEvidence}=await import('../docs/acceptance/topic-context-completeness/scripts/recover-notification-readback.mjs')
 const dir=await mkdtemp(resolve('docs/tmp/notice-evidence-test-'))
 const first=await appendNoticeEvidence(dir,'repair-readback',{receipt:{command:'native'}})
 const second=await appendNoticeEvidence(dir,'repair-readback',{receipt:{alreadyDelivered:true}})
 assert.notEqual(first,second);assert.deepEqual(JSON.parse(await readFile(first,'utf8')),{receipt:{command:'native'}})
 assert.equal((await readdir(dir)).length,2)
})

import { assertNoticeBatch } from '../docs/acceptance/topic-context-completeness/scripts/recover-notification-readback.mjs'
test('双ACK批次只接受指定维护和完整allowlist，部分已送达可安全接续',()=>{
 const manifest={maintenanceId:'batch',maintenanceRevision:193,actorId:'operator',notices:[{notificationId:'n1'},{notificationId:'n2'}]}
 const state={active:true,phase:'draining',maintenanceId:'batch',revision:193,actorId:'operator',busy:{nodes:0,owners:0,effects:0,messages:2}}
 const notices=[{id:'n1',status:'acknowledged'},{id:'n2',status:'acknowledged'}]
 assertNoticeBatch(state,manifest,notices)
 for(const field of ['nodes','owners','effects','messages'])assert.throws(()=>assertNoticeBatch({...state,busy:{...state.busy,[field]:state.busy[field]+1}},manifest,notices),/NOTICE_OTHER_WORK_ACTIVE/)
 assert.throws(()=>assertNoticeBatch({...state,revision:194},manifest,notices),/NOTICE_MAINTENANCE_CHANGED/)
 assert.throws(()=>assertNoticeBatch(state,{...manifest,notices:[manifest.notices[0],manifest.notices[0]]},notices),/NOTICE_BATCH_INVALID/)
 assert.throws(()=>assertNoticeBatch(state,manifest,[notices[0],{id:'n2',status:'unknown'}]),/NOTICE_IDENTITY_CHANGED/)
 assertNoticeBatch({...state,busy:{...state.busy,messages:1}},manifest,[{id:'n1',status:'delivered'},notices[1]])
})

test('批次回读仅移除准确引用发送人mention，错误人名或缺身份仍拒绝',()=>{
 const value=structuredClone(m)
 value.messages[0].quotedMessage.sender='李辰'
 value.messages[0].text='@李辰 内容 **Code.java**'
 assert.equal(verifyNoticeEvidence(n,c,status,value).messageId,'msg')
 for(const sender of ['其他人',undefined]){
  const changed=structuredClone(value);changed.messages[0].quotedMessage.sender=sender
  assert.throws(()=>verifyNoticeEvidence(n,c,status,changed),/NOTICE_READBACK_MISMATCH/)
 }
 const wrongQuote=structuredClone(value);wrongQuote.messages[0].quotedMessage.messageId='another-source'
 assert.throws(()=>verifyNoticeEvidence(n,c,status,wrongQuote),/NOTICE_READBACK_MISMATCH/)
})
