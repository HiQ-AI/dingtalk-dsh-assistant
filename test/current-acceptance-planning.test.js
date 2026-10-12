import test from 'node:test'
import assert from 'node:assert/strict'
import {validateConfiguredAcceptancePlan} from '../packages/dingtalk-dsh-assistant/task-workflow.js'
const context={request:'按实际原文修复数据集合并的七项UI交互',criteria:[{id:'criterion-1',description:'完成当前事项原文要求的交付'}],scenarios:[{id:'dataset-merge-ui',description:'真实候选组件七项UI验收'}],acceptanceApplicability:null}
const plan={cases:[{criterionId:'criterion-1',scenarioId:'dataset-merge-ui',steps:['执行候选组件七项交互并读取runner结果'],expected:'七项交互全部通过；API/list为显式fixture，backendVerified=false'}]}
test('configured actual UI scenario needs business plan but not duplicate applicability metadata',()=>assert.equal(validateConfiguredAcceptancePlan(plan,context),plan))
test('missing actual runner, criterion coverage, steps and fabricated scenario remain rejected',()=>{
 assert.throws(()=>validateConfiguredAcceptancePlan(plan,{...context,scenarios:[]}),{code:'LOCAL_ACCEPTANCE_CAPABILITY_MISSING'})
 for(const invalid of [{cases:[]},{cases:[{...plan.cases[0],scenarioId:'invented'}]},{cases:[{...plan.cases[0],steps:[]}]},{cases:[{...plan.cases[0],criterionId:'another'}]}])assert.throws(()=>validateConfiguredAcceptancePlan(invalid,context),{code:'LOCAL_ACCEPTANCE_PLAN_INVALID'})
})

import {defineExecutionWorkflow} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
test('v21 admits existing engineering edit tools while rejecting additional effects, tools and roles',()=>{
 const node={id:'apply-changes',version:'8',executor:'agent',provider:'test',model:'test',prompt:'read actual files and edit task scope',allowedEffects:['read','workspace.edit'],allowedTools:['engineering_repo_inspect','engineering_apply_edits'],inputSchema:{type:'object'},outputSchema:{type:'object'},mapInput:()=>({}),execute:async()=>({})}
 const workflow={id:'task-engineering-bound',version:'21',nodes:[node]}
 assert.doesNotThrow(()=>defineExecutionWorkflow(workflow))
 for(const change of [{allowedEffects:['read','git.push']},{allowedTools:[...node.allowedTools,'production_write']},{id:'other-agent'}])assert.throws(()=>defineExecutionWorkflow({...workflow,nodes:[{...node,...change}]}),{code:'EFFECT_NOT_ADMITTED'})
})
