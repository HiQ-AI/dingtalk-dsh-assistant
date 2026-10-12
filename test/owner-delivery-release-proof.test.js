import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {verifyDeliveredEngineeringFacts,readAcceptedProjectDeliveryProof,readOwnerAcceptedDeliveryBinding,validateOwnerCandidateAcceptance,readAcceptedCandidateCompletionEvidence} from '../packages/dingtalk-dsh-assistant/task-delivery-review.js'
const hash=x=>createHash('sha256').update(x).digest('hex')
async function fixture(t,twoProjects=false){
 const directory=await mkdtemp(join(tmpdir(),'owner-release-proof-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 const path=join(directory,'actual-evidence.md');await writeFile(path,'Actual seven case evidence, with documented fixture and real backend boundaries')
 const commit='a'.repeat(40),tree='b'.repeat(40),repository={id:'web',githubRepository:'Owner/web'},requirement={request:directory.replaceAll('\\','/'),target:{repositoryId:'web',uatEnvironment:'uat3'}}
 const pr={number:7,state:'OPEN',isDraft:true,mergedAt:null,headRefOid:commit,headRefName:'pure',baseRefName:'feature/uat3-base'}
 const secondDirectory=join(directory,'backend');if(twoProjects)await mkdir(secondDirectory)
 const secondRepository={id:'backend',githubRepository:'Owner/backend'},secondPr={number:8,state:'OPEN',isDraft:true,mergedAt:null,headRefOid:'d'.repeat(40),headRefName:'pure-backend',baseRefName:'feature/uat3-base'},queries=[]
 const queryCommand=async(command,args)=>{
  if(command==='gh'||command.endsWith('gh.exe')){const fields=args[args.indexOf('--json')+1].split(',');queries.push(fields);const actual=args[args.indexOf('--repo')+1]==='Owner/backend'?secondPr:pr;return JSON.stringify(Object.fromEntries(fields.filter(key=>Object.hasOwn(actual,key)).map(key=>[key,actual[key]])))}
  const second=args[args.indexOf('-C')+1]===secondDirectory
  if(args.includes('status'))return '';if(args.includes('remote'))return second?'https://github.com/Owner/backend.git':'https://github.com/Owner/web.git';if(args.includes('branch'))return second?'pure-backend':'pure';if(args.includes('rev-parse'))return args.includes('HEAD^{tree}')?(second?'e'.repeat(40):tree):(second?secondPr.headRefOid:commit);return 'actual source patch'
 }
 const input={kind:'project-evidence',runId:'original-run',projects:[{directory,repository:'Owner/web',commit,sourceBase:'c'.repeat(40),prNumber:7}],evidence:[{path,sha256:hash(await import('node:fs/promises').then(x=>x.readFile(path))),description:'Actual cases'}],scope:'Documented scopes only',acceptance:{scenarioIds:['seven-ui']}}
 const repositories=twoProjects?[repository,secondRepository]:[repository]
 if(twoProjects)input.projects.push({directory:secondDirectory,repository:'Owner/backend',commit:secondPr.headRefOid,sourceBase:'c'.repeat(40),prNumber:8})
 const facts=await verifyDeliveredEngineeringFacts({taskId:'task',repository,repositories,requirement,input,queryCommand})
 const binding={ref:'manifest',requirementRevision:2,planRevision:1},manifest={taskId:'task',source:'original-owner-delivery-review',complete:true,requirementRevision:2,planRevision:1,reviewRef:'facts',businessValidation:{status:'accepted',assessments:[{status:'satisfied'}]}}
 const objects={manifest,facts,requirement},store={query:async q=>q.kind==='task.owner.candidate-acceptance'?null:q.kind==='task.owner.delivery-manifest'?binding:{task:{requirementRef:'requirement'}}},artifacts={read:async ref=>objects[ref]}
 return {path,pr,secondPr,queries,facts,manifest,binding,options:{taskId:'task',repository:'Owner/web',headCommitSha:commit,pullRequestNumber:7,store,artifacts,repositories,queryCommand}}
}
test('original Owner acceptance binds current project/PR/tree/scenarios and permits ready PR without rerunning acceptance',async t=>{
 const f=await fixture(t);f.pr.isDraft=false
 const proof=await readAcceptedProjectDeliveryProof(f.options)
 assert.equal(proof.commitSha,f.pr.headRefOid);assert.deepEqual(proof.scenarioIds,['seven-ui']);assert.equal(proof.manifestRef,'manifest')
 await assert.rejects(readAcceptedProjectDeliveryProof({...f.options,headCommitSha:'d'.repeat(40)}),/CANDIDATE_MISMATCH/)
 f.pr.headRefOid='d'.repeat(40);await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/PR_MISMATCH/)
})
test('missing Owner acceptance, stale revision and changed evidence do not authorize release',async t=>{
 const f=await fixture(t);f.manifest.businessValidation.status='pending';await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/OWNER_ACCEPTANCE_REQUIRED/)
 f.manifest.businessValidation.status='accepted';f.manifest.requirementRevision=1;await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/OWNER_ACCEPTANCE_REQUIRED/)
 f.manifest.requirementRevision=2;await writeFile(f.path,'changed');await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/EVIDENCE_CHANGED/)
})

test('gh selector faithfully supplies and validates PR number before canonical evidence digest',async t=>{
 const f=await fixture(t);assert.ok(f.queries.every(fields=>fields.includes('number')))
 const proof=await readAcceptedProjectDeliveryProof(f.options);assert.match(proof.evidenceDigest,/^[a-f0-9]{64}$/)
 delete f.pr.number;await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/PR_MISMATCH/)
 f.pr.number=99;await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/PR_MISMATCH/)
})
test('second repository release accepts exact GitHub MERGED first PR, rejects CLOSED/unconfirmed/changed/selected merged PR',async t=>{
 const f=await fixture(t,true),second={...f.options,repository:'Owner/backend',headCommitSha:f.secondPr.headRefOid,pullRequestNumber:8}
 f.pr.state='MERGED';f.pr.mergedAt='2026-10-11T03:00:00Z';f.pr.isDraft=false
 assert.equal((await readAcceptedProjectDeliveryProof(second)).commitSha,f.secondPr.headRefOid)
 f.pr.state='CLOSED';f.pr.mergedAt=null;await assert.rejects(readAcceptedProjectDeliveryProof(second),/PR_MISMATCH/)
 f.pr.state='MERGED';await assert.rejects(readAcceptedProjectDeliveryProof(second),/PR_MISMATCH/)
 f.pr.mergedAt='2026-10-11T03:00:00Z';f.pr.headRefOid='f'.repeat(40);await assert.rejects(readAcceptedProjectDeliveryProof(second),/PR_MISMATCH/)
 f.pr.headRefOid=f.options.headCommitSha;f.secondPr.state='MERGED';f.secondPr.mergedAt='2026-10-11T03:01:00Z'
 await assert.rejects(readAcceptedProjectDeliveryProof(second),/CANDIDATE_MISMATCH/)
})


test('explicit original Owner candidate acceptance authorizes exact release candidate while task remains incomplete',async t=>{
 const f=await fixture(t),binding={ref:'candidate',requirementRevision:2,planRevision:1}
 const acceptance={kind:'task-candidate-acceptance',version:1,taskId:'task',source:'original-owner-delivery-review',accepted:true,businessCompleted:false,requirementRevision:2,planRevision:1,reviewRef:'facts',scenarioIds:['seven-ui'],evidenceRefs:['facts'],decision:{action:'wait',candidateAcceptance:{scenarioIds:['seven-ui'],evidenceRefs:['facts']}}}
 const query=f.options.store.query;f.options.store.query=async q=>q.kind==='task.owner.candidate-acceptance'?binding:query(q)
 const read=f.options.artifacts.read;f.options.artifacts.read=async ref=>ref==='candidate'?acceptance:read(ref)
 const proof=await readAcceptedProjectDeliveryProof(f.options);assert.equal(proof.manifestRef,'candidate');assert.deepEqual(proof.scenarioIds,['seven-ui'])
 acceptance.accepted=false;await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/OWNER_ACCEPTANCE_REQUIRED/)
 acceptance.accepted=true;acceptance.scenarioIds=['unreviewed'];await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/OWNER_ACCEPTANCE_REQUIRED/)
 acceptance.scenarioIds=['seven-ui'];f.pr.headRefOid='f'.repeat(40);await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/PR_MISMATCH/)
})
test('Owner candidate scenarios cannot be inferred from wait or expanded beyond reviewed facts',()=>{
 const facts={acceptance:{scenarioIds:['seven-ui']}},decision={action:'wait',evidenceRefs:['facts'],candidateAcceptance:{scenarioIds:['seven-ui'],evidenceRefs:['facts']}}
 assert.deepEqual(validateOwnerCandidateAcceptance({facts,decision,reviewRef:'facts'}),decision.candidateAcceptance)
 for(const change of [d=>delete d.candidateAcceptance,d=>d.action='complete',d=>d.candidateAcceptance.scenarioIds.push('new-scenario'),d=>d.candidateAcceptance.evidenceRefs=[]]){
  const d=structuredClone(decision);change(d);assert.throws(()=>validateOwnerCandidateAcceptance({facts,decision:d,reviewRef:'facts'}),/CANDIDATE_ACCEPTANCE_UNVERIFIED/)
 }
})

test('stage source selection and release proof prefer the same explicit candidate, retain legacy fallback',async()=>{
 const queries=[],candidate={ref:'new-candidate'},legacy={ref:'old-manifest'}
 const store={query:async q=>{queries.push(q);return q.kind==='task.owner.candidate-acceptance'?candidate:legacy}}
 assert.deepEqual(await readOwnerAcceptedDeliveryBinding({store,taskId:'task'}),{binding:candidate,candidate:true})
 assert.equal(queries.length,1)
 store.query=async q=>q.kind==='task.owner.candidate-acceptance'?null:legacy
 assert.deepEqual(await readOwnerAcceptedDeliveryBinding({store,taskId:'task'}),{binding:legacy,candidate:false})
 store.query=async()=>null
 assert.deepEqual(await readOwnerAcceptedDeliveryBinding({store,taskId:'task'}),{binding:null,candidate:false})
})

test('current original Owner accepted candidate remains real completion evidence after both PRs merge; drift still fails',async t=>{
 const f=await fixture(t,true),binding={ref:'candidate',requirementRevision:2,planRevision:1}
 const acceptance={kind:'task-candidate-acceptance',version:1,taskId:'task',source:'original-owner-delivery-review',accepted:true,businessCompleted:false,requirementRevision:2,planRevision:1,reviewRef:'facts',scenarioIds:['seven-ui'],evidenceRefs:['facts'],decision:{action:'wait',candidateAcceptance:{scenarioIds:['seven-ui'],evidenceRefs:['facts']}}}
 const query=f.options.store.query;f.options.store.query=async q=>q.kind==='task.owner.candidate-acceptance'?binding:q.kind==='task.plan'?{task:{requirementRef:'requirement',requirementRevision:14}}:query(q)
 const read=f.options.artifacts.read;f.options.artifacts.read=async ref=>ref==='candidate'?acceptance:read(ref)
 for(const pr of [f.pr,f.secondPr]){pr.state='MERGED';pr.mergedAt='2026-10-11T05:00:00Z';pr.isDraft=false}
 const evidence=await readAcceptedCandidateCompletionEvidence(f.options)
 assert.deepEqual(evidence.map(x=>x.evidenceRef),['candidate','facts']);assert.ok(evidence.every(x=>x.kind==='original-owner-candidate'&&x.requirementRevision===14&&x.ownerCandidate.sourceRequirementRevision===2&&x.ownerCandidate.businessCompleted===false))
 await assert.rejects(readAcceptedProjectDeliveryProof(f.options),/CANDIDATE_MISMATCH/)
 await writeFile(f.path,'Changed proof');await assert.rejects(readAcceptedCandidateCompletionEvidence(f.options),/EVIDENCE_CHANGED/)
})

for(const variant of ['valid','different-candidate','changed-bytes','unfinished-stage'])test(`registered publication supplement enters semantic evidence without rewriting acceptance: ${variant}`,async t=>{
 const f=await fixture(t),binding={ref:'candidate',requirementRevision:2,planRevision:1}
 const candidate={kind:'task-candidate-acceptance',version:1,taskId:'task',source:'original-owner-delivery-review',accepted:true,businessCompleted:false,requirementRevision:2,planRevision:1,reviewRef:'facts',scenarioIds:['seven-ui'],evidenceRefs:['facts'],decision:{action:'wait',candidateAcceptance:{scenarioIds:['seven-ui'],evidenceRefs:['facts']}}}
 const path=join(f.path,'..','runtime.json');await writeFile(path,'Actual same-instance post-start condition proof')
 const input={...f.facts.sourceInput,runId:'release-run',acceptance:undefined,evidence:[{path,sha256:hash('Actual same-instance post-start condition proof'),description:'Post-start proof'}]}
 if(variant==='different-candidate')input.projects=[{...input.projects[0],commit:'d'.repeat(40)}]
 const supplement={kind:'verified-delivered-engineering-facts',taskId:'task',runId:'release-run',sourceInput:input,evidence:input.evidence}
 const oldQuery=f.options.store.query,oldRead=f.options.artifacts.read
 f.options.store.query=async q=>q.kind==='task.owner.candidate-acceptance'?binding:q.kind==='task.owner.delivery-review-evidence'?{payloadRef:'supplement',requirementRevision:2}:q.kind==='task.plan'?{task:{requirementRef:'requirement',requirementRevision:2},stages:[{stageId:'release',runId:'release-run',status:variant==='unfinished-stage'?'running':'succeeded',outputRef:'release-output'}]}:oldQuery(q)
 f.options.artifacts.read=async ref=>ref==='candidate'?candidate:ref==='supplement'?supplement:oldRead(ref)
 f.pr.state='MERGED';f.pr.mergedAt='2026-10-12T08:08:01Z';f.pr.isDraft=false
 if(variant==='changed-bytes')await writeFile(path,'Altered proof')
 const before=JSON.stringify(candidate)
 if(variant==='valid'){
  const evidence=await readAcceptedCandidateCompletionEvidence(f.options)
  assert.equal(evidence[1].evidence.reviewedFacts.supplementaryReviews[0].reviewRef,'supplement')
  assert.equal(evidence[1].evidence.reviewedFacts.supplementaryReviews[0].evidence[0].content,'Actual same-instance post-start condition proof')
  assert.equal(evidence[0].ownerCandidate.businessCompleted,false)
 }else await assert.rejects(readAcceptedCandidateCompletionEvidence(f.options),/MISMATCH|SOURCE_CHANGED|EVIDENCE_CHANGED|PUBLICATION_UNVERIFIED/)
 assert.equal(JSON.stringify(candidate),before)
})
