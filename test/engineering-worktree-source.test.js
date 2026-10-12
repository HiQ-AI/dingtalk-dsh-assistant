import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {freezeCandidate,readCandidate,assertCandidateWorktree,withCandidateWorkspaceUse,verifyCandidate} from '../packages/dingtalk-dsh-assistant/execution-candidate.js'
import {createWorktreeVerificationJobCheck} from '../packages/dingtalk-dsh-assistant/execution-check-job.js'
import {createWorktreeAcceptanceRunner} from '../packages/dingtalk-dsh-assistant/execution-worktree-acceptance.js'
import {normalizeWorktreeAcceptancePlan} from '../packages/dingtalk-dsh-assistant/task-workflow.js'
const exec=promisify(execFile)
async function fixture(t,value='original'){
 const root=await mkdtemp(join(tmpdir(),'shared-source-')),source=join(root,'repository'),git=async(...args)=>(await exec('git',['-C',source,...args],{windowsHide:true})).stdout.trim()
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(source);await git('init','-b','main');await git('config','user.name','Test');await git('config','user.email','test@example.invalid')
 await writeFile(join(source,'.gitignore'),'target/\n');await writeFile(join(source,'value.txt'),value);await git('add','.');await git('commit','-m','base')
 const candidate=await freezeCandidate({repository:source,baseCommit:await git('rev-parse','HEAD'),generation:1,requirementDigest:'a'.repeat(64)})
 return {root,source,candidate}
}
test('worktree check executes in original source without export and preserves source changes/nonzero failures',async t=>{
 const {root,source,candidate}=await fixture(t),rootChecks=join(root,'checks'),command=code=>({executable:process.execPath,args:['-e',code]})
 const check=createWorktreeVerificationJobCheck({id:'build',version:'1',root:rootChecks,...command("console.log(process.cwd());require('fs').mkdirSync('target',{recursive:true});require('fs').writeFileSync('target/build.txt','build')")})
 const snapshot=await readCandidate(candidate),result=await check.run({...snapshot,candidateDigest:candidate.digest})
 assert.equal(result.passed,true);assert.equal(JSON.parse(result.log).directory,source);assert.ok((await readdir(rootChecks)).every(n=>n.startsWith('verify-logs-')))
 const bad=createWorktreeVerificationJobCheck({id:'build',version:'2',root:rootChecks,...command("process.exit(7)")})
 const failure=await bad.run({...snapshot,candidateDigest:candidate.digest});assert.equal(failure.passed,false);assert.equal(JSON.parse(failure.log).exitCode,7)
 const mutate=createWorktreeVerificationJobCheck({id:'build',version:'3',root:rootChecks,...command("require('fs').writeFileSync('value.txt','changed')")})
 const drift=await mutate.run({...snapshot,candidateDigest:candidate.digest});assert.equal(drift.passed,false);assert.equal(JSON.parse(drift.log).sourceFailure,'CANDIDATE_WORKTREE_CHANGED')
 await assert.rejects(assertCandidateWorktree(candidate),{code:'CANDIDATE_WORKTREE_CHANGED'})
})
test('shared worktree excludes concurrent use and allows configured generated files only',async t=>{
 const {source,candidate}=await fixture(t);let release;const held=withCandidateWorkspaceUse(source,()=>new Promise(r=>release=r));while(!release)await new Promise(r=>setTimeout(r,1))
 await assert.rejects(withCandidateWorkspaceUse(source,()=>assert.fail('overlap')),{code:'CANDIDATE_WORKTREE_BUSY'});release();await held
 await mkdir(join(source,'dist'));await writeFile(join(source,'dist/generated.txt'),'output');await assert.rejects(assertCandidateWorktree(candidate),{code:'CANDIDATE_WORKTREE_CHANGED'})
 await assertCandidateWorktree(candidate,{generatedDirectories:['dist']});await writeFile(join(source,'extra-source.js'),'extra');await assert.rejects(assertCandidateWorktree(candidate,{generatedDirectories:['dist']}),{code:'CANDIDATE_WORKTREE_CHANGED'})
})
test('worktree acceptance does not copy source and accepts long actual business prose',async t=>{
 const expected='actual result '.repeat(300)
 const {root,source,candidate}=await fixture(t,expected),profile=join(root,'profile.json'),command=code=>({executable:process.execPath,args:['-e',code]})
 await writeFile(profile,JSON.stringify({environment:'uat',env:{PROFILE_MARKER:'isolated-secret'}}))
 const readInput="let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const input=JSON.parse(s);"
 const config={version:'1',instructions:'notes'.repeat(2000),sharedDataProfilePath:profile,prepareSteps:[],service:command("require('http').createServer((q,r)=>r.end(require('fs').readFileSync('value.txt','utf8'))).listen(Number(process.argv[1]),process.argv[2])"),scenarios:[{id:'value',description:'description'.repeat(300),...command(readInput+"console.log(JSON.stringify({namespace:input.namespace,baseUrl:input.baseUrl,actual:await(await fetch(input.baseUrl)).text()}));});")}],cleanup:command(readInput+"console.log(JSON.stringify({namespace:input.namespace}));});"),verifyCleanup:command(readInput+"console.log(JSON.stringify({namespace:input.namespace,empty:true}));});")}
 config.service.args.push('{port}','127.0.0.1');config.service.readyPath='/'
 const runner=createWorktreeAcceptanceRunner({root:join(root,'acceptance'),tempRoot:join(root,'tmp'),config})
 const plan=normalizeWorktreeAcceptancePlan({cases:[{expected,steps:['step'.repeat(800)]}]},{request:'actual target',criteria:[{id:'criterion-1',description:'goal'}],scenarios:runner.scenarios})
 const prepared=await runner.prepare({candidate,plan,taskId:'task',runId:'run',generation:1,uatEnvironment:'uat1'})
 assert.equal(prepared.directory,source);assert.equal(prepared.sourceMode,'task-worktree');assert.ok(!(await readdir(join(root,'acceptance',prepared.identity))).includes('candidate'))
 const receipt=await runner.execute(prepared);assert.equal(receipt.passed,true,JSON.stringify(receipt));assert.equal(receipt.checks[0].actual,expected);await runner.assertPassed(prepared,receipt)
 assert.deepEqual(await runner.execute(prepared),receipt);
 const wrong=await runner.prepare({candidate,plan:{cases:plan.cases.map(item=>({...item,expected:expected+' wrong'}))},taskId:'task',runId:'run',generation:1,uatEnvironment:'uat1'})
 const failed=await runner.execute(wrong);assert.equal(failed.passed,false);assert.equal(failed.checks[0].actual,expected);await assert.rejects(runner.assertPassed(wrong,failed),{code:'LOCAL_ACCEPTANCE_FAILED'});await assert.rejects(runner.assertPassed(wrong,{...failed,passed:true}),{code:'LOCAL_ACCEPTANCE_RECEIPT_INVALID'});await assert.rejects(runner.retryPrepared(wrong,{attemptKey:'unsafe-retry'}),{code:'LOCAL_ACCEPTANCE_RETRY_NOT_CLEAN'})
 await writeFile(join(source,'value.txt'),'different');await assert.rejects(runner.assertPassed(prepared,receipt),{code:'CANDIDATE_WORKTREE_CHANGED'})
})
