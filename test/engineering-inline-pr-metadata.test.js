import test from 'node:test'
import assert from 'node:assert/strict'
import {createEngineeringInlineAcceptanceWorkflow} from '../packages/dingtalk-dsh-assistant/task-workflow.js'
const context={scenarios:[{id:'s',description:'test'}]}
const options={adapterIdentity:'adapter',prepareGeneration:async({input})=>input,workflowId:'task-engineering-test',provider:'test',model:'test',project:{repository:'other/project',uatEnvironment:'uat1',targetCommit:'a'.repeat(40),taskBase:'a'.repeat(40)},discovery:{allowedPrefixes:['']},workspaceAdapter:{identity:'workspace'},editAdapter:{identity:'edit'},deliveryPlan:{expectedRemoteSha:null,identity:'delivery',gitAdapterFor:()=>({}),prAdapterFor:()=>({}),date:'1700000000 +0000',commitMessage:'change',title:'change',body:'actual changes'},localAcceptance:{identity:'actual',scenarios:context.scenarios},checks:[{id:'real-build',version:'1',run:async()=>({passed:true,log:'exit 0'})}]}
test('v25 PR derives paths in Host when input lacks metadata but still rejects missing verification',async()=>{
 let pathsRead=0,prepared
 const workflow=createEngineeringInlineAcceptanceWorkflow({...options,localAcceptance:{...options.localAcceptance,assertPassed:async(_,receipt)=>assert.equal(receipt.passed,true)},readCommitChangedPaths:async input=>{pathsRead++;assert.equal(input.commitId,'b'.repeat(40));return ['actual/from/git.js']},deliveryPlan:{...options.deliveryPlan,prAdapterFor:async()=>({prepare:async input=>(prepared=input)})}})
 const node=workflow.nodes.find(n=>n.id==='prepare-pr'),input={currentRequest:'real requested change',localEvidence:{localPrepared:{},localAcceptance:{passed:true,candidateDigest:'c'.repeat(64),checks:[],uatEnvironment:'uat1',identity:'unit-local-proof'}},prepared:{commitId:'b'.repeat(40),repository:'actual repository',candidateDigest:'c'.repeat(64),verificationDigest:'proof',verification:{passed:true,digest:'proof',checks:[{id:'build',version:'1',passed:true,log:'actual result'}]}}}
 await node.execute({input,runId:'run',generation:1,requirementDigest:'requirement'});assert.equal(pathsRead,1);assert.ok(prepared.body.includes('actual/from/git.js'))
 await assert.rejects(node.execute({input:{...input,prepared:{...input.prepared,verification:undefined}}}),{code:'ENGINEERING_PR_EVIDENCE_REQUIRED'})
})
