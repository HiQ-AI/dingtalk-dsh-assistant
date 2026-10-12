import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {readRealHttpEvidence} from '../scripts/sg20-real-http-evidence.mjs'
// Reader contract fixture, not a claim that the SG20 business UAT ran in CI.
async function fixture(t){
 const parent=resolve('docs/tmp');await mkdir(parent,{recursive:true})
 const root=await mkdtemp(join(parent,'sg20-evidence-contract-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const config={taskId:'task-83c651ebdbdb77584a06d1fcb6b9e255',requirementRevision:6,uatEnvironment:'uat3',requestDigest:'37ad98f0fcd7378478ffd1767d51407ae8e0c2744b81b88b642b71e327a39a8c',backend:{head:'candidate-head',path:root},frontend:{path:root+'/frontend'}}
 const proof={backend:{head:config.backend.head,path:root,mainSourceTree:'backend-tree',newUntrackedTest:'candidate-test.java'},frontend:{sourceTree:'frontend-tree'},finalRun:{id:'synthetic-reader-contract',tests:11,httpRequests:47,successfulMergeWrites:10,failures:0,errors:0,skipped:0,mavenExit:0},cleanup:{allThreeSchemasAbsent:true,publicTestRows:0,remainingKeys:0,independentProbeExit:0}}
 for(const k of ['httpVerified','postgresVerified','redisVerified','realAuthInterceptor','realDstTransactional'])proof.finalRun[k]=true
 for(const k of ['mergeServicesMocked','persistenceMocked','publicBusinessWrites','productionWrites','realNotifications','domVerified','uat3DeploymentVerified'])proof.finalRun[k]=false
 const evidenceHashes={};await mkdir(join(root,'round-3'))
 for(const [key,name] of [['log','real-http-round3.log'],['test','candidate-test.java'],['xml','round-3/TEST-com.ecdigit.ecdata.service.merge.DatasetMergeRealHttpDatabaseTest.xml'],['cleanup','independent-cleanup.log']]){const bytes=Buffer.from(`synthetic reader contract ${key}\n`);await writeFile(join(root,name),bytes);evidenceHashes[key]=createHash('sha256').update(bytes).digest('hex')}
 await writeFile(join(root,'verification.json'),JSON.stringify(proof))
 const git=(repo,args)=>args[0]==='rev-parse'?(repo===config.backend.path?'backend-tree':'frontend-tree'):''
 return {config,proof,options:{root,evidenceHashes,git}}
}
test('synthetic HTTP reader proof stays partial and candidate-bound',async t=>{const {config,options}=await fixture(t);const r=await readRealHttpEvidence(config,options);assert.equal(r.tests,11);assert.equal(r.httpRequests,47);assert.equal(r.domVerified,false);assert.equal(r.fullAcceptanceComplete,false)})
test('different task or requirement cannot reuse HTTP reader proof',async t=>{const {config,options}=await fixture(t);await assert.rejects(readRealHttpEvidence({...config,taskId:'other'},options),/TASK_SCOPE/);await assert.rejects(readRealHttpEvidence({...config,requirementRevision:2},options),/REQUIREMENT_SCOPE/)})
test('changed candidate source or raw log rejects HTTP reader proof',async t=>{const {config,options}=await fixture(t);await assert.rejects(readRealHttpEvidence(config,{...options,git:()=> 'different-tree'}),/SOURCE_CHANGED/);await writeFile(join(options.root,'real-http-round3.log'),'edited');await assert.rejects(readRealHttpEvidence(config,options),/EVIDENCE_CHANGED:log/)})
test('dirty candidate, missing hash and false cleanup reject proof',async t=>{const {config,proof,options}=await fixture(t);await assert.rejects(readRealHttpEvidence(config,{...options,git:(repo,args)=>args[0]==='diff'?'dirty':options.git(repo,args)}),/WORKTREE_SOURCE_CHANGED/);await assert.rejects(readRealHttpEvidence(config,{...options,evidenceHashes:{}}),/EVIDENCE_HASH_REQUIRED/);proof.cleanup.remainingKeys=1;await writeFile(join(options.root,'verification.json'),JSON.stringify(proof));await assert.rejects(readRealHttpEvidence(config,options))})
test('each evidence file and frontend source remains independently bound',async t=>{const {config,options}=await fixture(t);await assert.rejects(readRealHttpEvidence(config,{...options,git:(repo,args)=>args[0]==='rev-parse'&&repo===config.frontend.path?'changed-frontend':options.git(repo,args)}),/FRONTEND_SOURCE_CHANGED/);for(const key of ['log','test','xml','cleanup']){await assert.rejects(readRealHttpEvidence(config,{...options,evidenceHashes:{...options.evidenceHashes,[key]:'0'.repeat(64)}}),new RegExp('EVIDENCE_CHANGED:'+key))}})
