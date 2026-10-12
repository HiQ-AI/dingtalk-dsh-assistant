import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEngineeringAcceptancePlan, createEngineeringMinimalWorkflow, createEngineeringLeanWorkflow } from '../packages/dingtalk-dsh-assistant/task-workflow.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
const context={request:'actual objective',criteria:[{id:'criterion-1',description:'actual goal'}],scenarios:[{id:'actual',description:'execute actual scenario'}]}
test('minimal acceptance derives only deterministic metadata; expected is still supplied',()=>{
 const normalized=normalizeEngineeringAcceptancePlan({cases:[{expected:'actual business result'}]},context)
 assert.deepEqual(normalized.cases,[{expected:'actual business result',criterionId:'criterion-1',scenarioId:'actual',steps:['execute actual scenario'],parameters:{}}])
 assert.deepEqual(normalizeEngineeringAcceptancePlan(normalized,context),normalized)
 for(const plan of [{cases:[]},{cases:[{}]},{cases:[{expected:' '} ]},{cases:[{expected:'pass',scenarioId:'invented'}]},{cases:[{expected:'pass',parameters:[]}]}])assert.throws(()=>normalizeEngineeringAcceptancePlan(plan,context),{code:'LOCAL_ACCEPTANCE_PLAN_INVALID'})
 assert.throws(()=>normalizeEngineeringAcceptancePlan({cases:[{expected:'pass'}]},{...context,scenarios:[...context.scenarios,{id:'another'}]}),{code:'LOCAL_ACCEPTANCE_PLAN_INVALID'})
 assert.throws(()=>normalizeEngineeringAcceptancePlan({cases:[{expected:'pass'}]},{...context,scenarios:[]}),{code:'LOCAL_ACCEPTANCE_CAPABILITY_MISSING'})
})
const options={adapterIdentity:'adapter',prepareGeneration:async ({input})=>input,workflowId:'task-engineering-test',provider:'test',model:'test',project:{repository:'other/project',uatEnvironment:'uat3',targetCommit:'a'.repeat(40),taskBase:'a'.repeat(40)},discovery:{allowedPrefixes:['']},workspaceAdapter:{identity:'workspace'},editAdapter:{identity:'edit'},deliveryPlan:{expectedRemoteSha:null,identity:'delivery',gitAdapterFor:()=>({}),prAdapterFor:()=>({}),date:'1700000000 +0000',commitMessage:'change',title:'change',body:'actual changes'},localAcceptance:{identity:'actual',scenarios:context.scenarios},checks:[{id:'real-build',version:'1',run:async()=>({passed:true,log:'exit 0'})}]}
test('v23 retains every fixed node; planning notes and repeated identities cannot block implementation',()=>{
 const old=createEngineeringMinimalWorkflow(options),next=createEngineeringLeanWorkflow(options)
 assert.deepEqual(next.nodes.map(n=>n.id),old.nodes.map(n=>n.id));assert.equal(next.nodes.length,17)
 assert.equal(next.nodes.some(n=>n.id==='validate-proposal'),false)
 const proposed=next.nodes.find(n=>n.id==='inspect-and-propose'),planned=next.nodes.find(n=>n.id==='plan-local-acceptance'),apply=next.nodes.find(n=>n.id==='apply-changes')
 const proposal={document:{markdown:'Reuse existing handler.'},scopePaths:['../only-a-planning-note']}
 assert.deepEqual(validateJsonSchemaValue(proposed.outputSchema,proposal),[]);assert.doesNotThrow(()=>proposed.validateOutput({output:proposal}))
 assert.deepEqual(validateJsonSchemaValue(planned.outputSchema,{cases:[{expected:'actual result'}]}),[])
 assert.deepEqual(validateJsonSchemaValue(apply.outputSchema,{status:'succeeded'}),[])
 assert.ok(validateJsonSchemaValue(old.nodes.find(n=>n.id==='plan-local-acceptance').outputSchema,{cases:[{expected:'actual result'}]}).length)
 assert.doesNotThrow(()=>defineExecutionWorkflow(next));assert.equal(defineExecutionWorkflow(old).version,'22')
 for(const change of [{allowedTools:[...apply.allowedTools,'production_write']},{allowedEffects:['read','git.push']},{id:'another-agent'}])assert.throws(()=>defineExecutionWorkflow({...next,nodes:next.nodes.map(n=>n.id==='apply-changes'?{...n,...change}:n)}))
})

import {hostVerificationScope,validateJUnitCoverage,main} from '../scripts/verify-dataset-unit-tests.mjs'
test('generic native test discovery needs no pinned suite and keeps current Host identity',async()=>{
 const scope={taskId:'task-other',stageId:null,repositoryId:'arbitrary-project',requestDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64)}
 assert.deepEqual(hostVerificationScope({DSH_VERIFICATION_SCOPE:JSON.stringify(scope)}),scope)
 assert.throws(()=>hostVerificationScope({DSH_VERIFICATION_SCOPE:JSON.stringify({...scope,candidateDigest:'invalid'})}),/JUNIT_HOST_SCOPE_REQUIRED/)
 const line='HOST_JUNIT_CASE:'+['DifferentClassName','realCase','executed',''].map(x=>Buffer.from(x).toString('base64')).join(':')
 assert.equal((await validateJUnitCoverage(line,undefined,scope)).cases.length,1)
 await assert.rejects(validateJUnitCoverage('',undefined,scope),/JUNIT_EXECUTED_TESTS_MISSING/)
 await assert.rejects(validateJUnitCoverage(line.replace(Buffer.from('executed').toString('base64'),Buffer.from('skipped').toString('base64')),undefined,scope))
})

import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
test('native evidence works from arbitrary project directory and preserves real nonzero exit',async t=>{
 const root=await mkdtemp(join(tmpdir(),'arbitrary-project-')),project=join(root,'other-repository'),maven=join(root,'maven')
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(project);await mkdir(join(maven,'boot'),{recursive:true})
 await writeFile(join(maven,'boot','plexus-classworlds-fixture.jar'),'invalid jar intentionally exercises a real Java failure')
 await assert.rejects(main(['--java','D:/soft/jdk-11.0.2/bin/java.exe','--maven-home',maven],project),/DATASET_TEST_COMMAND_FAILED/)
 const [proof]=await readdir(join(project,'target'));assert.ok(proof.startsWith('host-unit-'))
 const evidence=(await readdir(join(project,'target',proof))).find(x=>x.endsWith('.json'))
 const result=JSON.parse(await readFile(join(project,'target',proof,evidence),'utf8'))
 assert.equal(result.candidateDirectory,project);assert.equal(result.taskId,null)
 assert.equal(result.steps[0].exitCode,0);assert.equal(result.steps[1].step,'maven-tests');assert.notEqual(result.steps[1].exitCode,0)
 assert.ok(result.steps.every(step=>step.stdoutPath.startsWith(join(project,'target'))&&step.stderrPath.startsWith(join(project,'target'))))
})
