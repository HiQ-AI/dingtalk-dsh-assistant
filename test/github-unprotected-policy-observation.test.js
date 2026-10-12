import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlatformClients} from '../packages/dingtalk-dsh-assistant/workflow-platform-clients.js'
const repository='HiQ-AI/dataset-web',branch='feature/uat3-base',commit='a'.repeat(40)
const planMessage='Upgrade to GitHub Pro or make this repository public to enable this feature.'
const row=(name=branch,sha=commit,protectedValue=false)=>({name,commit:{sha},protected:protectedValue})
const response=(body,status=200)=>({ok:status===200,status,json:async()=>body})
function fixture({message=planMessage,protectedValue=false,pages=[ [row()] ],after=row(),network=false,rules}={}) {
 const calls=[];let branchReads=0
 const github=createPlatformClients({githubMergeWritesEnabled:true,fetchImpl:async url=>{
  calls.push(url)
  if(url.includes('branches?protected=false')) {
   if(network)throw Error('network unavailable')
   const page=Number(new URL(url).searchParams.get('page'));return response(pages[page-1]??[])
  }
  if(url.includes('/rules/branches/'))return rules===undefined?response({message},403):response(rules)
  if(url.endsWith('/protection'))return response({required_status_checks:{contexts:['ci'],checks:[]}})
  if(url.includes('/branches/'))return response(++branchReads===1?row(branch,commit,protectedValue):after)
  throw Error('unexpected request')
 }}).github
 return {github,calls}
}
for(const method of ['readAtomicPushPolicy','readRequiredChecks']) {
 test(`${method}: exact plan403 requires complete official unprotected list and current SHA`,async()=>{
  const pages=[Array.from({length:100},(_,i)=>row('first-'+i)),Array.from({length:100},(_,i)=>row('second-'+i)),[row()]]
  const {github,calls}=fixture({pages});const result=await github[method]({repository,branch})
  assert.equal(method==='readAtomicPushPolicy'?result.allowed:result.complete,true)
  assert.equal(calls.filter(url=>url.includes('protected=false')).length,3)
  assert.equal(calls.filter(url=>url.includes('/branches/')&&!url.includes('/rules/')).length,2)
  if(method==='readRequiredChecks'){assert.deepEqual(result.checks,[]);assert.equal(result.observation.status,'confirmed-unprotected');assert.equal(result.observation.commitSha,commit)}
 })
}
test('permission403 is not a plan error and cannot trigger fallback',async()=>{
 const {github,calls}=fixture({message:'Resource not accessible by integration'})
 await assert.rejects(github.readAtomicPushPolicy({repository,branch}),/PLATFORM_HTTP_403/)
 assert.equal(calls.some(url=>url.includes('protected=false')),false)
})
test('protected target with plan403 stays blocked',async()=>{
 const {github,calls}=fixture({protectedValue:true})
 await assert.rejects(github.readRequiredChecks({repository,branch}),/PLATFORM_HTTP_403/)
 assert.equal(calls.some(url=>url.includes('protected=false')),false)
})
for(const [name,options,code] of [
 ['missing target',{pages:[[row('other')]]},'GITHUB_RULES_UNCONFIRMED'],
 ['listed SHA differs',{pages:[[row(branch,'b'.repeat(40))]]},'GITHUB_RULES_UNCONFIRMED'],
 ['contradictory protected result',{pages:[[row(branch,commit,true)]]},'GITHUB_RULES_UNCONFIRMED'],
 ['duplicate list entries',{pages:[[row(),row()]]},'GITHUB_RULES_UNCONFIRMED'],
 ['after-list branch drift',{after:row(branch,'b'.repeat(40))},'GITHUB_RULES_UNCONFIRMED'],
 ['network error',{network:true},'PLATFORM_REQUEST_FAILED'],
 ['unfinished pagination',{pages:Array.from({length:100},(_,p)=>Array.from({length:100},(_,i)=>row(`page-${p}-${i}`)))},'GITHUB_RULES_INCOMPLETE']
])test(name+' cannot confirm unprotected policy',async()=>{
 const {github}=fixture(options);await assert.rejects(github.readAtomicPushPolicy({repository,branch}),new RegExp(code))
})
test('ordinary protected policy retains required checks and atomic restrictions',async()=>{
 const {github}=fixture({protectedValue:true,rules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'lint',integration_id:7}]}}]})
 const result=await github.readRequiredChecks({repository,branch});assert.deepEqual(result.checks,[{name:'ci'},{name:'lint',appId:7}]);assert.equal(result.observation.status,'confirmed-rules')
 const restricted=fixture({rules:[{type:'pull_request'}]}).github
 await assert.rejects(restricted.readAtomicPushPolicy({repository,branch}),/UAT_ATOMIC_PUSH_POLICY_UNSUPPORTED/)
})
