import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeWorktreeAcceptancePlan,createEngineeringLeanWorkflow,createEngineeringWorktreeWorkflow} from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import {defineExecutionWorkflow} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
const context={request:'actual target',criteria:[{id:'c',description:'criterion'}],scenarios:[{id:'s',description:'description'}]}
test('worktree acceptance fills deterministic context and rejects missing required business expectations',()=>{
 const expected='real expected '.repeat(1000),steps=['business step '.repeat(1000)]
 const plan=normalizeWorktreeAcceptancePlan({cases:[{expected,steps}]},context)
 assert.equal(plan.cases[0].expected,expected);assert.deepEqual(plan.cases[0].steps,steps)
 assert.deepEqual(plan.cases[0].parameters,{});assert.equal(plan.cases[0].criterionId,'c');assert.equal(plan.cases[0].scenarioId,'s')
 assert.deepEqual(normalizeWorktreeAcceptancePlan(plan,context),plan)
 for(const invalid of [{cases:[]},{cases:[{}]},{cases:[{expected:' '}]},{cases:[{expected:'yes',parameters:[]}]},{cases:[{expected:'yes',steps:[' ']}]},{cases:[{expected:'yes',scenarioId:'wrong'}]}])assert.throws(()=>normalizeWorktreeAcceptancePlan(invalid,context),{code:'LOCAL_ACCEPTANCE_PLAN_INVALID'})
 assert.throws(()=>normalizeWorktreeAcceptancePlan({cases:[{expected:'yes'}]},{...context,scenarios:[...context.scenarios,{id:'other'}]}),{code:'LOCAL_ACCEPTANCE_PLAN_INVALID'})
 assert.throws(()=>normalizeWorktreeAcceptancePlan({cases:[{expected:'yes'}]},{...context,criteria:[]}),{code:'LOCAL_ACCEPTANCE_CAPABILITY_MISSING'})
})
const options={adapterIdentity:'adapter',prepareGeneration:async({input})=>input,workflowId:'task-engineering-test',provider:'test',model:'test',project:{repository:'other/project',uatEnvironment:'uat1',targetCommit:'a'.repeat(40),taskBase:'a'.repeat(40)},discovery:{allowedPrefixes:['']},workspaceAdapter:{identity:'workspace'},editAdapter:{identity:'edit'},deliveryPlan:{expectedRemoteSha:null,identity:'delivery',gitAdapterFor:()=>({}),prAdapterFor:()=>({}),date:'1700000000 +0000',commitMessage:'change',title:'change',body:'actual changes'},localAcceptance:{identity:'actual',scenarios:context.scenarios},checks:[{id:'real-build',version:'1',run:async()=>({passed:true,log:'exit 0'})}]}
test('v24 retains all 17 nodes and no extra change-list or model identity output',async()=>{
 const old=createEngineeringLeanWorkflow(options),next=createEngineeringWorktreeWorkflow(options)
 assert.deepEqual(next.nodes.map(n=>n.id),old.nodes.map(n=>n.id));assert.equal(next.version,'24');assert.equal(next.nodes.length,17)
 assert.equal(next.nodes.some(n=>n.id==='validate-proposal'),false)
 assert.deepEqual(next.nodes.find(n=>n.id==='apply-changes').outputSchema.required,['status'])
 assert.deepEqual(next.nodes.find(n=>n.id==='plan-local-acceptance').outputSchema.properties.cases.items.required,['expected'])
 const define=next.nodes.find(n=>n.id==='define-local-acceptance'),target='goal '.repeat(1000)
 assert.equal((await define.execute({input:{request:'target',acceptanceCriteria:[target]}})).localContext.criteria[0].description,target)
 await assert.rejects(define.execute({input:{request:'target',acceptanceCriteria:[]}}),{code:'LOCAL_ACCEPTANCE_CRITERIA_REQUIRED'})
 assert.doesNotThrow(()=>defineExecutionWorkflow(next));assert.equal(defineExecutionWorkflow(old).version,'23')
 for(const forbidden of [{allowedTools:['shell']},{allowedEffects:['git.push']},{id:'new-development-node'}])assert.throws(()=>defineExecutionWorkflow({...next,nodes:next.nodes.map(n=>n.id==='apply-changes'?{...n,...forbidden}:n)}))
})
