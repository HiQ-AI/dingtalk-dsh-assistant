import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {verifyDeliveredEngineeringFacts} from '../packages/dingtalk-dsh-assistant/task-delivery-review.js'
import {handleRequest} from '../packages/dingtalk-dsh-assistant/http.js'
const hash=x=>createHash('sha256').update(x).digest('hex')
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'delivered-facts-')),commit='a'.repeat(40),xml='<testsuite tests="3" errors="0" failures="0" skipped="0"></testsuite>',cleanup=JSON.stringify({exists:false,readOnly:true,query:'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=?)'})
 await mkdir(join(directory,'target/surefire-reports'),{recursive:true})
 for(const [file,value] of [['source.txt','actual code'],['target/surefire-reports/TEST-Test.xml',xml],['business.xml',xml],['cleanup.json',cleanup],['jar','binary jar']])await writeFile(join(directory,file),value)
 const proof={taskId:'task',originalRunId:'run',sourceBase:'b'.repeat(40),deployed:false,nativeRunReexecuted:false,fullAppStarted:false,realNotificationsVerified:false,applicability:{allSameExceptLineEndings:true,proof:[{path:'source.txt',canonicalSha256:hash('actual code')}]},directedTests:{reports:[{file:'TEST-Test.xml',tests:3,errors:0,failures:0,skipped:0}],totalTests:3},realPostgres:{tests:3,junitSha256:hash(xml)}}
 await writeFile(join(directory,'verification.json'),JSON.stringify(proof))
 const pr={number:1,state:'OPEN',isDraft:true,headRefOid:commit,headRefName:'original-delivery',baseRefName:'feature/uat2-base',mergedAt:null,url:'https://github.com/example/repository/pull/1'}
 const options={taskId:'task',requirement:{request:directory.replaceAll('\\','/'),target:{repositoryId:'repo',uatEnvironment:'uat2'}},repository:{id:'repo',githubRepository:'example/repository'},input:{directory,repository:'example/repository',commit,runId:'run',verificationFile:'verification.json',businessJUnitPath:join(directory,'business.xml'),cleanupPath:join(directory,'cleanup.json'),cleanupSha256:hash(cleanup),jarPath:join(directory,'jar'),jarSha256:hash('binary jar'),prNumber:1},queryCommand:async(command,args)=>command.endsWith('gh.exe')||command==='gh'?JSON.stringify(pr):args.includes('rev-parse')?commit:args.includes('status')?'':args.includes('branch')?'original-delivery':'actual source diff'}
 return {options,pr,directory}
}
test('artifact formats are not admission gates; Owner receives actual failed report bytes',async()=>{
 const f=await fixture();const result=await verifyDeliveredEngineeringFacts(f.options);assert.equal(result.scope.submitted.realNotificationsVerified,false);assert.equal(result.sourcePatch,'actual source diff')
 await writeFile(join(f.directory,'target/surefire-reports/TEST-Test.xml'),'<testsuite tests="3" errors="0" failures="1" skipped="0"></testsuite>')
 const changed=await verifyDeliveredEngineeringFacts(f.options);assert.match(changed.unitReports[0].content,/failures="1"/);assert.notEqual(changed.unitReports[0].sha256,result.unitReports[0].sha256)
})
test('foreign task, repository, changed code and changed PR head are rejected',async()=>{
 const f=await fixture();await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,taskId:'foreign'}),{code:'TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID'})
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,input:{...f.options.input,repository:'foreign/repository'}}),{code:'TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH'})
 f.pr.headRefOid='c'.repeat(40);await assert.rejects(verifyDeliveredEngineeringFacts(f.options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'});f.pr.headRefOid=f.options.input.commit
 await writeFile(join(f.directory,'source.txt'),'changed code');await assert.rejects(verifyDeliveredEngineeringFacts(f.options),{code:'TASK_DELIVERY_REVIEW_SOURCE_CHANGED'})
})
test('external evidence paths cannot escape authorized requirement',async()=>{
 const f=await fixture(),outside=await mkdtemp(join(tmpdir(),'foreign-review-'));await writeFile(join(outside,'cleanup.json'),'{}')
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,input:{...f.options.input,cleanupPath:join(outside,'cleanup.json')}}),{code:'TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID'})
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,input:{...f.options.input,verificationFile:'../verification.json'}}),{code:'TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID'})
})
test('retired HTTP review rejects valid and forged requests without invoking review',async()=>{
 const calls=[],server=createServer((request,response)=>handleRequest(request,response,{reviewWorkflowTaskDelivery:async args=>{calls.push(args);return {status:'pending'}}},{testApiEnabled:false}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{
 const input={requestId:'review',expectedRequirementRevision:1,expectedControlRevision:2,reason:'Review delivered facts',facts:{runId:'run',directory:'D:/task',repository:'example/repository',commit:'a'.repeat(40),prNumber:1,verificationFile:'verification.json',businessJUnitPath:'D:/task/business.xml',cleanupPath:'D:/task/cleanup.json',cleanupSha256:'b'.repeat(64),jarPath:'D:/task/jar',jarSha256:'c'.repeat(64)}}
 const post=(body,origin)=>fetch(`http://127.0.0.1:${server.address().port}/tasks/task/review-delivery`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
 assert.equal((await post(input,'https://foreign.example')).status,410);assert.equal((await post({...input,actorId:'forged'})).status,410);assert.equal((await post({...input,facts:{...input.facts,passed:true}})).status,410)
 assert.equal((await post(input,'http://127.0.0.1:3080')).status,410);assert.equal(calls.length,0)
 const generic={...input,facts:{kind:'project-evidence',runId:'run',projects:[{directory:'D:/task',repository:'example/repository',commit:'a'.repeat(40),sourceBase:'b'.repeat(40),prNumber:1}],evidence:[{path:'D:/task/dom.md',sha256:'c'.repeat(64),description:'Actual component DOM; fixture APIs'}],scope:'Component DOM only; not deployed'}}
 assert.equal((await post(generic,'http://127.0.0.1:3080')).status,410);assert.equal(calls.length,0)
 }finally{await new Promise(resolve=>server.close(resolve))}
})
