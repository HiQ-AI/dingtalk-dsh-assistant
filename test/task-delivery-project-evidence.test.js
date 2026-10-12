import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {verifyDeliveredEngineeringFacts} from '../packages/dingtalk-dsh-assistant/task-delivery-review.js'
const hash=x=>createHash('sha256').update(x).digest('hex')
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'project-review-')),path=join(directory,'dom.json'),commit='a'.repeat(40)
 await writeFile(path,'{"fixtureApis":true,"deployed":false}')
 const pr={number:1,state:'OPEN',isDraft:true,mergedAt:null,headRefOid:commit,headRefName:'candidate',baseRefName:'feature/uat3-base'}
 const repository={id:'frontend',githubRepository:'example/frontend'}
 const options={taskId:'task',requirement:{request:directory.replaceAll('\\','/'),target:{repositoryId:'frontend',uatEnvironment:'uat3'}},repository,repositories:[repository],input:{kind:'project-evidence',runId:'run',projects:[{directory,repository:'example/frontend',commit,sourceBase:'b'.repeat(40),prNumber:1}],evidence:[{path,sha256:hash('{"fixtureApis":true,"deployed":false}'),description:'Component DOM with fixture APIs'}],scope:'Component DOM only; no integrated saving'},queryCommand:async(command,args)=>command.endsWith('gh.exe')||command==='gh'?JSON.stringify(pr):args.includes('rev-parse')?commit:args.includes('status')?'':args.includes('branch')?'candidate':args.includes('remote')?'https://github.com/example/frontend.git':'actual diff'}
 return {options,path,pr,directory}
}
test('generic evidence preserves fixture limits and gives actual bytes to Owner without declaring acceptance',async()=>{
 const f=await fixture(),facts=await verifyDeliveredEngineeringFacts(f.options)
 assert.equal(facts.projects[0].commit,f.options.input.projects[0].commit)
 assert.equal(JSON.parse(facts.evidence[0].content).fixtureApis,true)
 assert.equal(facts.scope.submitted,f.options.input.scope)
 assert.equal(facts.scope.deployed,false)
 assert.equal(facts.passed,undefined)
 await writeFile(f.path,'changed')
 await assert.rejects(verifyDeliveredEngineeringFacts(f.options),{code:'TASK_DELIVERY_REVIEW_EVIDENCE_CHANGED'})
})
test('repository, PR head and evidence root cannot be substituted',async()=>{
 const f=await fixture()
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,repositories:[]}),{code:'TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH'})
 f.pr.headRefOid='c'.repeat(40)
 await assert.rejects(verifyDeliveredEngineeringFacts(f.options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'})
 f.pr.headRefOid=f.options.input.projects[0].commit
 const outside=await mkdtemp(f.directory+'-foreign-'),path=join(outside,'dom.json');await writeFile(path,'x')
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,input:{...f.options.input,evidence:[{path,sha256:hash('x'),description:'outside'}]}}),{code:'TASK_DELIVERY_REVIEW_EVIDENCE_SCOPE_INVALID'})
})
test('all projects must pass, primary project required, duplicates rejected',async()=>{
 const f=await fixture(),second={...f.options.input.projects[0],repository:'example/backend'}
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,input:{...f.options.input,projects:[f.options.input.projects[0],second]}}),{code:'TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH'})
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,input:{...f.options.input,projects:[f.options.input.projects[0],f.options.input.projects[0]]}}),{code:'TASK_DELIVERY_REVIEW_REPOSITORY_MISMATCH'})
})

// Cross-repository follow-up reuses an unchanged exact already-merged project.
test('mixed lifecycle review permits exact merged project, rejects closed, missing merge receipt, changed head and non-draft new candidate',async()=>{
 const f=await fixture(); f.pr.number=1; f.pr.state='MERGED'; f.pr.isDraft=false; f.pr.mergedAt='2026-10-11T09:05:04Z';
 await assert.rejects(verifyDeliveredEngineeringFacts(f.options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'});
 const options={...f.options,allowMerged:true}; assert.equal((await verifyDeliveredEngineeringFacts(options)).projects[0].pr.state,'MERGED');
 f.pr.state='CLOSED'; await assert.rejects(verifyDeliveredEngineeringFacts(options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'});
 f.pr.state='MERGED'; f.pr.mergedAt=null; await assert.rejects(verifyDeliveredEngineeringFacts(options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'});
 f.pr.mergedAt='2026-10-11T09:05:04Z'; f.pr.headRefOid='e'.repeat(40); await assert.rejects(verifyDeliveredEngineeringFacts(options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'});
 f.pr.headRefOid=f.options.input.projects[0].commit; f.pr.state='OPEN'; f.pr.mergedAt=null;
 await assert.rejects(verifyDeliveredEngineeringFacts(options),{code:'TASK_DELIVERY_REVIEW_PR_MISMATCH'});
 assert.equal((await verifyDeliveredEngineeringFacts({...options,requireDraft:false})).projects[0].pr.isDraft,false);
})

test('current effective task constraints authorize evidence roots; old constraint history cannot restore them',async()=>{
 const f=await fixture(),requirement={...f.options.requirement,request:'Publish the already reviewed candidate',constraints:[`Use existing evidence in ${f.directory.replaceAll('\\','/')}`]}
 assert.equal((await verifyDeliveredEngineeringFacts({...f.options,requirement})).projects[0].commit,f.options.input.projects[0].commit)
 await assert.rejects(verifyDeliveredEngineeringFacts({...f.options,requirement:{...requirement,constraints:[],constraintHistory:[{constraints:requirement.constraints}]}}),{code:'TASK_DELIVERY_REVIEW_DIRECTORY_NOT_AUTHORIZED'})
})
