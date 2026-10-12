import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const TASK='task-83c651ebdbdb77584a06d1fcb6b9e255'
const ROOT='D:/project/sg20-http-integration-20261010/docs/acceptance/sg20-real-http'
const EXPECTED={log:'9354ffc3ecfc88364dce8825c2f4610e7bac9c0825c95d49affa2ba51076ad99',test:'93e28d5cc70a12fbb36bbc56468eaaf10c54ceb66ee251f59b1c80cbc327adcd',xml:'d3a1dbc9f1f636af3f84a12263103333969cf9a1659d957224840bac2e347666',cleanup:'a38b314699cf65ec01d56d2ca761017081a1572c8efa055a219c4021c16e35ad'}
const sha=b=>createHash('sha256').update(b).digest('hex')
export async function readRealHttpEvidence(config,{root=ROOT,read=readFile,git=(repo,args)=>execFileSync('git',['-c',`safe.directory=${repo}`,'-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim()}={}){
 assert.equal(config.taskId,TASK,'TASK_SCOPE_MISMATCH');assert.equal(config.requirementRevision,6,'REQUIREMENT_SCOPE_MISMATCH');assert.equal(config.uatEnvironment,'uat3','TARGET_SCOPE_MISMATCH');assert.equal(config.requestDigest,'37ad98f0fcd7378478ffd1767d51407ae8e0c2744b81b88b642b71e327a39a8c','REQUEST_SCOPE_MISMATCH')
 const proof=JSON.parse(await read(root+'/verification.json','utf8'))
 assert.equal(proof.backend.head,config.backend.head,'BACKEND_CANDIDATE_MISMATCH')
 assert.equal(git(config.backend.path,['rev-parse','HEAD:src/main']),proof.backend.mainSourceTree,'BACKEND_SOURCE_CHANGED')
 assert.equal(git(config.frontend.path,['rev-parse','HEAD:src']),proof.frontend.sourceTree,'FRONTEND_SOURCE_CHANGED')
 for(const [file,key] of [[root+'/real-http-round3.log','log'],[proof.backend.path+'/'+proof.backend.newUntrackedTest,'test'],[root+'/round-3/TEST-com.ecdigit.ecdata.service.merge.DatasetMergeRealHttpDatabaseTest.xml','xml'],[root+'/independent-cleanup.log','cleanup']]) assert.equal(sha(await read(file)),EXPECTED[key],`EVIDENCE_CHANGED:${key}`)
 for(const [repo,source] of [[config.backend.path,'src/main'],[config.frontend.path,'src']]){assert.equal(git(repo,['diff','HEAD','--',source]),'','WORKTREE_SOURCE_CHANGED');assert.equal(git(repo,['ls-files','--others','--exclude-standard','--',source]),'','UNTRACKED_SOURCE_CHANGED')}
 const f=proof.finalRun,c=proof.cleanup;assert.equal(f.httpRequests,47);assert.equal(f.successfulMergeWrites,10)
 assert.equal(f.tests,11);for(const k of ['failures','errors','skipped','mavenExit'])assert.equal(f[k],0)
 for(const k of ['httpVerified','postgresVerified','redisVerified','realAuthInterceptor','realDstTransactional'])assert.equal(f[k],true)
 for(const k of ['mergeServicesMocked','persistenceMocked','publicBusinessWrites','productionWrites','realNotifications','domVerified','uat3DeploymentVerified'])assert.equal(f[k],false)
 assert.equal(c.allThreeSchemasAbsent,true);assert.equal(c.publicTestRows,0);assert.equal(c.remainingKeys,0);assert.equal(c.independentProbeExit,0)
 return {httpVerified:true,postgresVerified:true,redisVerified:true,taskId:TASK,requirementRevision:6,tests:11,httpRequests:f.httpRequests,successfulMergeWrites:f.successfulMergeWrites,domVerified:false,uat3DeploymentVerified:false,fullAcceptanceComplete:false,evidenceKind:'existing-real-run-bound-to-current-candidate-source',runId:f.id,evidenceRoot:root,externalSso:'controlled-test-fixture',cleanupIndependentlyVerified:true,hashes:EXPECTED}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const[flag,path]=process.argv.slice(2);assert.equal(flag,'--config');console.log(JSON.stringify(await readRealHttpEvidence(JSON.parse(await readFile(path,'utf8')))))}catch(e){console.error(JSON.stringify({code:'SG20_REAL_HTTP_EVIDENCE_REJECTED',message:e.message}));process.exitCode=1}}
