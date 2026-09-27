import {readFile,writeFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {executionDigest} from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js';
const root=new URL('../round-32/',import.meta.url);
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const authorization='我授权对 HiQ-AI/dataset PR #371 执行这一次已审阅的未知操作恢复：仅按本轮冻结标题、正文和 UAT3 目标编辑已有 PR，不创建、合并或推送；如结果不确定仅回读，不再次发送。';
const fail=code=>{throw Error(code)};
export function validateEffect(row,m){
 const prepared=JSON.parse(row?.definition_json??'{}').payload;
 if(row?.effect_id!==m.effectId||row.run_id!==m.runId||row.state!=='unknown'||row.definition_digest!==m.definitionDigest||!prepared||prepared.digest!==m.prepared.digest||executionDigest(prepared)!==executionDigest(m.prepared))fail('RECOVERY_EFFECT_DRIFT');
 const {digest,...body}=prepared;if(executionDigest(body)!==digest)fail('RECOVERY_PREPARED_INVALID');
 if(prepared.repo!=='HiQ-AI/dataset'||prepared.previousPullRequest?.number!==371||prepared.commitId!==m.commitId||prepared.operationKey!==m.operationKey)fail('RECOVERY_SCOPE_INVALID');
}
export function verifyBefore(pr,m){
 if(pr.number!==371||pr.state!=='OPEN'||pr.headRefOid!==m.commitId||pr.headRefName!==m.prepared.head||pr.baseRefName!==m.before.baseRefName||pr.title!==m.before.title||hash(pr.body)!==m.before.bodySha256||pr.lastEditedAt!==m.before.lastEditedAt||pr.updatedAt!==m.before.updatedAt)fail('RECOVERY_PR_DRIFT');
 if(!pr.body.includes(`<!-- dsh-operation:${m.prepared.previousPullRequest.operationKey} -->`))fail('RECOVERY_OLD_MARKER_MISSING');
}
export function observed(pr,m){return pr.number===371&&pr.state==='OPEN'&&pr.headRefOid===m.commitId&&pr.headRefName===m.prepared.head&&pr.baseRefName===m.prepared.base&&pr.title===m.prepared.title&&pr.body===m.newBody;}
export async function recover({manifest:m,mode,authorizationText,readEffect,readPr,edit,reservationPath,bodyPath,resultPath}){
 if(!['check','execute'].includes(mode))fail('RECOVERY_MODE_INVALID');
 validateEffect(await readEffect(),m);
 let reserved;try{reserved=JSON.parse(await readFile(reservationPath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 if(reserved){if(reserved.manifestDigest!==executionDigest(m))fail('RECOVERY_RESERVATION_DRIFT');return {writes:0,remoteEditAttempts:0,confirmedRemoteWrites:0,replayed:true,status:observed(await readPr(),m)?'observed':'unknown',nextAction:'原生reconcile回读；禁止重发'};}
 verifyBefore(await readPr(),m);
 const preview={mode,writes:0,remoteEditAttempts:0,confirmedRemoteWrites:0,effectId:m.effectId,preparedDigest:m.prepared.digest,pr:'https://github.com/HiQ-AI/dataset/pull/371',commitId:m.commitId,target:m.prepared.base,title:m.prepared.title,bodyChars:m.newBody.length,bodySha256:hash(m.newBody),operationKey:m.operationKey,capability:'existing PR edit only'};
 if(mode==='check')return preview;
 if(authorizationText!==authorization)fail('RECOVERY_USER_AUTHORIZATION_REQUIRED');
 const reservation=await open(reservationPath,'wx',0o600);
 try{await reservation.writeFile(JSON.stringify({manifestDigest:executionDigest(m),authorizationText,createdAt:new Date().toISOString()}));await reservation.sync()}finally{await reservation.close()}
 // reservation precedes all possible writes; any subsequent error permanently disallows another edit.
 try {
  validateEffect(await readEffect(),m);verifyBefore(await readPr(),m);
  await writeFile(bodyPath,m.newBody,{flag:'wx',mode:0o600});
 } catch(error) {
  await writeFile(resultPath,JSON.stringify({...preview,status:'not-attempted',editAttempted:false,reserved:true,reason:error.message},null,2),{flag:'wx',mode:0o600});
  throw error;
 }
 let uncertain=false;try{await edit(m,bodyPath)}catch{uncertain=true}
 let current;try{current=await readPr()}catch{uncertain=true}
 const confirmed=!!current&&observed(current,m);
 const result={...preview,remoteEditAttempts:1,editAttempted:true,confirmedRemoteWrites:confirmed?1:0,status:confirmed?'observed':'unknown',transportUncertain:uncertain,nextAction:'原生reconcile回读；禁止重发'};
 await writeFile(resultPath,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return result;
}
async function gh(args){return new Promise((resolve,reject)=>{const p=spawn('C:/Program Files/GitHub CLI/gh.exe',args,{shell:false,windowsHide:true,env:{...process.env,GH_PROMPT_DISABLED:'1',GH_PAGER:'cat'},stdio:['ignore','pipe','pipe']});let text='',stderr='',size=0;const timer=setTimeout(()=>{p.kill();reject(Error('RECOVERY_GH_TIMEOUT'))},30000);for(const stream of [p.stdout,p.stderr])stream.on('data',b=>{size+=b.length;if(size>262144){p.kill();reject(Error('RECOVERY_GH_LIMIT'))}if(stream===p.stdout)text+=b;else stderr+=b});p.on('error',()=>{clearTimeout(timer);reject(Error('RECOVERY_GH_FAILED'))});p.on('close',code=>{clearTimeout(timer);code===0?resolve(text):reject(Error(/TLS handshake timeout|i\/o timeout|connection reset|unexpected EOF|HTTP 50[234]|network is unreachable/i.test(stderr)?'RECOVERY_GH_TRANSIENT':'RECOVERY_GH_FAILED'))})})}
export async function readOnlyRetry(read){for(let attempt=0;attempt<3;attempt++){try{return await read()}catch(error){if(attempt===2||!['RECOVERY_GH_TIMEOUT','RECOVERY_GH_TRANSIENT'].includes(error.message))throw error;await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)))}}}
export async function readLivePr(){const result=JSON.parse(await readOnlyRetry(()=>gh(['api','graphql','-f','query=query {repository(owner:"HiQ-AI",name:"dataset"){pullRequest(number:371){number url state title body headRefOid headRefName baseRefName lastEditedAt updatedAt}}}'])));if(result.errors)fail('RECOVERY_READ_FAILED');return result.data.repository.pullRequest;}
export function readLiveEffect(){const db=new DatabaseSync('D:/dsh_home/workflows/runtime-v2/control.sqlite',{readOnly:true});try{return db.prepare('SELECT * FROM execution_effects WHERE effect_id=?').get('git-53f2dfc6458bb6f3e171908285fd98233bfc09e5c4fe1c320ecbd50cbe6a8b57')}finally{db.close()}}
async function main(){const [flag,...rest]=process.argv.slice(2);if(!['--check','--execute'].includes(flag)||rest.length!==(flag==='--execute'?2:0)||(rest.length&&rest[0]!=='--authorization-file'))fail('RECOVERY_ARGUMENT_INVALID');
 const m=JSON.parse(await readFile(new URL('pr371-recovery-manifest.json',root),'utf8'));if(executionDigest(m)!=='ad79714e913609b66b9b24298dff97bcf2704319ea6cfaf2fb9466c682d47242')fail('RECOVERY_MANIFEST_DRIFT');if(m.effectId!=='git-53f2dfc6458bb6f3e171908285fd98233bfc09e5c4fe1c320ecbd50cbe6a8b57')fail('RECOVERY_SCOPE_INVALID');
 const auth=rest.length?JSON.parse(await readFile(rest[1],'utf8')):null;if(auth&&auth.manifestDigest!==executionDigest(m))fail('RECOVERY_AUTHORIZATION_DRIFT');
 console.log(JSON.stringify(await recover({manifest:m,mode:flag.slice(2),authorizationText:auth?.text,readEffect:readLiveEffect,readPr:readLivePr,reservationPath:new URL('pr371-recovery-reservation.json',root),bodyPath:fileURLToPath(new URL('pr371-recovery-body.md',root)),resultPath:new URL('pr371-recovery-result.json',root),edit:async(m,bodyPath)=>gh(['pr','edit','371','--repo','HiQ-AI/dataset',...(m.before.baseRefName===m.prepared.base?[]:['--base',m.prepared.base]),'--title',m.prepared.title,'--body-file',bodyPath])}),null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
