import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,readFile,unlink,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {resolve,join} from 'node:path'
import {freezeCandidate,readCandidate,assertCandidateWorktree,withCandidateWorkspaceUse} from '../packages/dingtalk-dsh-assistant/execution-candidate.js'
import {createWorktreeVerificationJobCheck} from '../packages/dingtalk-dsh-assistant/execution-check-job.js'
import {createWorktreeAcceptanceRunner} from '../packages/dingtalk-dsh-assistant/execution-worktree-acceptance.js'
import {acceptanceCriteriaSchema} from '../packages/dingtalk-dsh-assistant/task-input-contract.js'
const root=resolve('docs/tmp/review-core-regression')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function fixture(t){
 await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'repo-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const git=(...args)=>execFileSync('git',['-C',dir,...args],{windowsHide:true,encoding:'utf8'}).trim()
 git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid')
 await writeFile(join(dir,'keep.txt'),'keep');await writeFile(join(dir,'removed.js'),'process.exit(0)');await writeFile(join(dir,'.gitignore'),'target/\n');git('add','.');git('commit','-m','base')
 return {dir,git,candidate:await freezeCandidate({repository:dir,baseCommit:git('rev-parse','HEAD'),generation:1,requirementDigest:'a'.repeat(64)})}
}
test('a frozen tracked deletion remains absent, including ignored/generated restored paths, in build and acceptance preparation',async t=>{
 const {dir,git}=await fixture(t);const baseCommit=git('rev-parse','HEAD');await unlink(join(dir,'removed.js'))
 const candidate=await freezeCandidate({repository:dir,baseCommit,generation:1,requirementDigest:'a'.repeat(64)});await assertCandidateWorktree(candidate)
 await writeFile(join(dir,'removed.js'),'console.log("uncommitted success")')
 await assert.rejects(assertCandidateWorktree(candidate,{generatedDirectories:['removed.js']}),{code:'CANDIDATE_WORKTREE_CHANGED'})
 const check=createWorktreeVerificationJobCheck({id:'build',version:'1',root:join(dir,'target/logs'),executable:process.execPath,args:['removed.js']})
 await assert.rejects(check.run({...await readCandidate(candidate),candidateDigest:candidate.digest}),{code:'CANDIDATE_WORKTREE_CHANGED'})
 const profile=join(dir,'target/profile.json');await mkdir(join(dir,'target'),{recursive:true});await writeFile(profile,JSON.stringify({environment:'uat',env:{MARKER:'test-secret'}}))
 const command={executable:process.execPath,args:['-e','process.exit(0)']}
 const runner=createWorktreeAcceptanceRunner({root:join(dir,'target/accept'),tempRoot:join(dir,'target/tmp'),config:{version:'1',sharedDataProfilePath:profile,prepareSteps:[],service:{...command,args:['-e','process.exit(0)','{port}','127.0.0.1'],readyPath:'/'},scenarios:[{id:'real',description:'real',...command}],cleanup:command,verifyCleanup:command}})
 await assert.rejects(runner.prepare({candidate,plan:{cases:[{criterionId:'criterion-1',scenarioId:'real',steps:['real'],expected:'real',parameters:{}}]},taskId:'task',runId:'run',generation:1,uatEnvironment:'uat1'}),{code:'CANDIDATE_WORKTREE_CHANGED'})
})
test('normal parent exit waits for detached child and orphan grandchild; later source drift fails verification',async t=>{
 const {dir,candidate}=await fixture(t)
 const grandchild="setTimeout(()=>require('fs').writeFileSync('keep.txt','CHANGED_AFTER_PARENT_EXIT'),2500);setTimeout(()=>{},4000)"
 const middle="const c=require('child_process').spawn(process.execPath,['-e',"+JSON.stringify(grandchild)+"],{detached:true,stdio:'ignore',windowsHide:true});c.unref()"
 const parent="const c=require('child_process').spawn(process.execPath,['-e',"+JSON.stringify(middle)+"],{detached:true,stdio:'ignore',windowsHide:true});c.unref()"
 const check=createWorktreeVerificationJobCheck({id:'build',version:'1',root:join(dir,'target/logs'),executable:process.execPath,args:['-e',parent]})
 const result=await check.run({...await readCandidate(candidate),candidateDigest:candidate.digest}),log=JSON.parse(result.log)
 assert.equal(result.passed,false);assert.equal(log.exitCode,0);assert.equal(log.sourceFailure,'CANDIDATE_WORKTREE_CHANGED');assert.ok(log.steps[0].elapsedMs>=4000)
 assert.equal(await readFile(join(dir,'keep.txt'),'utf8'),'CHANGED_AFTER_PARENT_EXIT')
 assert.equal(JSON.parse((await readFile(join(log.logDirectory,'step-1.drained.json'),'utf8')).replace(/^\uFEFF/,'')).executionDrained,true)
})
test('parent exit with a harmless child advances only after all descendants exit; real nonzero exit retained',async t=>{
 const {dir,candidate}=await fixture(t);const code="const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1600)'],{detached:true,stdio:'ignore',windowsHide:true});c.unref()"
 const run=async args=>createWorktreeVerificationJobCheck({id:'build',version:'1',root:join(dir,'target/logs'),executable:process.execPath,args}).run({...await readCandidate(candidate),candidateDigest:candidate.digest})
 const result=await run(['-e',code]);assert.equal(result.passed,true);assert.ok(JSON.parse(result.log).steps[0].elapsedMs>=1600)
 const bad=await run(['-e','process.exit(7)']);assert.equal(bad.passed,false);assert.equal(JSON.parse(bad.log).exitCode,7)
})
test('an unknown process drain retains the in-process worktree lock',async t=>{
 const {dir}=await fixture(t)
 await assert.rejects(withCandidateWorkspaceUse(dir,async()=>{throw Object.assign(new Error('unknown'),{executionDrained:false})}),/unknown/)
 await assert.rejects(withCandidateWorkspaceUse(dir,async()=>assert.fail('released unknown lock')),{code:'CANDIDATE_WORKTREE_BUSY'})
})
test('the real shared Task ingress admits an original 5000-character criterion and rejects empty criteria',()=>{
 const original='原'.repeat(5000);assert.deepEqual(acceptanceCriteriaSchema.parse([original]),[original]);assert.equal(acceptanceCriteriaSchema.safeParse(['  ']).success,false)
})
