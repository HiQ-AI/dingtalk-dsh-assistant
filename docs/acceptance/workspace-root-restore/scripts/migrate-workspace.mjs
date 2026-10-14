import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,lstatSync,existsSync,rmSync,rmdirSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {checkMigration,migrateMetadataAndFiles} from './migrate-runtime-data.mjs';
import {planNativeRelocations,applyNativeRelocations} from './native-session-relocation.mjs';
import {inspectLedger} from '../../task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs';
const sourceRoot=resolve('D:/baibu-agent/task-session-runtime-clean'),targetRoot=resolve('D:/baibu-agent'),globalRoot=resolve('D:/dsh_home/sessions');
const evidence=resolve('docs/acceptance/workspace-root-restore');
const hash=b=>createHash('sha256').update(b).digest('hex');
const within=(root,path)=>{const p=relative(root,path);return p!== '..'&&!p.startsWith('..'+sep)&&!isAbsolute(p)};
const record=(name,value)=>writeFileSync(join(evidence,name),JSON.stringify(value,null,2)+'\n');
const args=process.argv.slice(2);assert.ok(args.length===1&&['--check','--apply'].includes(args[0]));
let phase='planning';
try{
 const plan=checkMigration();
 const records=await planNativeRelocations({taskDataRoot:sourceRoot,sourceRoot,targetRoot,globalRoot});
 for(const item of records)item.fileSha256=hash(readFileSync(item.sourceFile));
 assert.equal(records.filter(r=>!r.global).length,3);assert.equal(records.filter(r=>r.global).length,5);
 const summary={checkOnly:args[0]==='--check',writes:0,sourceRoot,targetRoot,pidExited:plan.pidExited,files:plan.entries.filter(x=>x.type==='file').length,moveCount:plan.moves.length,metadataEdits:plan.edits.length,protectedPathRows:plan.database.changes.length,native:records.map(r=>({sessionId:r.id,global:r.global,originalEventCount:r.eventCount,originalEventDigest:r.eventDigest,sourceFileSha256:r.fileSha256,targetCwd:r.targetCwd}))};
 if(args[0]==='--check'){console.log(JSON.stringify(summary));process.exitCode=0}
 else{
  assert.ok(plan.pidExited,'OLD_PID_STILL_ALIVE');
  record('migration-plan.json',summary);
  record('pre-migration-offline.json',inspectLedger(join(sourceRoot,'.dsh/task-sessions.sqlite'),sourceRoot,true,46748));
  phase='metadata';const metadata=migrateMetadataAndFiles(plan);record('metadata-migration.json',metadata);
  phase='native';const stagingRoot=join(sourceRoot,'.migration-staging');
  const native=await applyNativeRelocations(records,{sourceRoot,targetRoot,stagingRoot});record('native-migration.json',native);
  phase='independent-verification';
  const newLedger=inspectLedger(join(targetRoot,'.dsh/task-sessions.sqlite'),targetRoot,true,46748);record('new-root-offline-ledger.json',newLedger);
  for(const proof of native){
   const old=records.find(r=>r.id===proof.sessionId);assert.ok(old);
   const oldFile=join(proof.stage,'session.v4.jsonl');assert.equal(hash(readFileSync(oldFile)),old.fileSha256);
  }
  // 原生模块完成一次官方读回；清理前再独立扫描新日志头与原事件前缀。
  for(const proof of native){
   const old=records.find(r=>r.id===proof.sessionId);let found=0;
   function scan(p){for(const name of readdirSync(p)){const f=join(p,name),s=lstatSync(f);assert.ok(!s.isSymbolicLink());if(s.isDirectory())scan(f);else if(name==='session.v4.jsonl'){const lines=readFileSync(f,'utf8').trim().split('\n');const h=JSON.parse(lines[0]);if(h.id===proof.sessionId){found++;assert.equal(h.cwd,proof.cwd);assert.equal(hash(Buffer.from(JSON.stringify(lines.slice(1,1+old.eventCount).map(JSON.parse)))),old.eventDigest)}}}}
   scan(proof.backendRoot);assert.equal(found,1);
  }
  phase='cleanup-originals';
  assert.equal(sourceRoot,resolve('D:/baibu-agent/task-session-runtime-clean'));assert.ok(within(targetRoot,sourceRoot));
  const allowed=new Map(native.map(p=>[resolve(join(p.stage,'session.v4.jsonl')),records.find(r=>r.id===p.sessionId).fileSha256]));let staged=0;
  function verifyRemains(p){const s=lstatSync(p);assert.ok(!s.isSymbolicLink());if(s.isDirectory())for(const n of readdirSync(p))verifyRemains(join(p,n));else{assert.ok(within(stagingRoot,p));assert.ok(allowed.has(resolve(p)),'UNEXPECTED_SOURCE_FILE');assert.equal(hash(readFileSync(p)),allowed.get(resolve(p)));staged++}}
  verifyRemains(sourceRoot);assert.equal(staged,records.length);
  rmSync(sourceRoot,{recursive:true});assert.ok(!existsSync(sourceRoot));
  // 仅移除已确认空的原生cwd编码容器，不递归处理DSH全局其他会话。
  for(const item of records){const originalParent=item.global?dirname(dirname(item.sourceFile)):join(targetRoot,relative(sourceRoot,dirname(dirname(item.sourceFile))));if(within(item.global?globalRoot:targetRoot,originalParent)&&existsSync(originalParent)&&readdirSync(originalParent).length===0)rmdirSync(originalParent)}
  record('migration-proof.json',{completedAt:new Date().toISOString(),sourceAbsent:true,metadataVerified:true,nativeVerified:native.length,originalEventPrefixesPreserved:true,legacyReceiptsPreserved:true,noAliases:true,backupRetained:false});
  console.log(JSON.stringify({migrated:true,nativeSessions:native.length,sourceAbsent:true,root:targetRoot}));
 }
}catch(error){if(args[0]==='--apply')record('migration-failure.json',{phase,code:error.code??null,message:error.message,migrationReceipt:error.migrationReceipt??null});console.error(JSON.stringify({phase,error:error.message}));process.exitCode=1}

