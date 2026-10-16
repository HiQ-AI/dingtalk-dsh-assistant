import { trackTestService } from './fixtures/owned-test-service.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {freezeCandidate} from '../packages/dingtalk-dsh-assistant/execution-candidate.js'
import {createTaskLocalAcceptanceRunner} from '../packages/dingtalk-dsh-assistant/execution-task-local-acceptance.js'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openExecutionArtifacts,executionDigest} from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import {createExecutionController,defineExecutionWorkflow} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import {createExecutionDelivery} from '../packages/dingtalk-dsh-assistant/execution-delivery.js'

// Only isolated SQLite/files and real loopback child processes. Synthetic seven-case
// reports exercise recovery admission; they are never SG20 UI/backend evidence.
const ids=['SG20-01-selection','SG20-02-columns','SG20-03-panel','SG20-04-filter-scroll','SG20-05-steps','SG20-06-notice','SG20-07-description']
const expected=JSON.stringify({uiContract:true,coverage:'candidate-ui-with-explicit-api-and-list-fixtures',backendVerified:false})
const exec=promisify(execFile)
const child=`
import {createServer} from 'node:http';import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';import {join} from 'node:path';
let raw='';for await(const c of process.stdin)raw+=c;const input=JSON.parse(raw),role=process.argv[2];
await appendFile(process.env.TRACE,JSON.stringify({role,namespace:input.namespace})+'\\n');
if(role==='service'){createServer((q,r)=>{r.writeHead(200);r.end('ready')}).listen(Number(process.argv[4]),process.argv[3]);}
else if(role==='scenario'){
 const ready=await fetch(input.baseUrl+'/ready');if(!ready.ok)process.exit(4);
 let fixed=false;try{await readFile(process.env.FIXED);fixed=true}catch{}
 const ids=${JSON.stringify(ids)},directory=join(process.env.REPORTS,input.namespace);await mkdir(directory,{recursive:true});
 const cases=ids.map(id=>({id,status:fixed||id!=='SG20-03-panel'?'PASS':'FAIL',error:id==='SG20-03-panel'?'1 !== 0':''}));
 await writeFile(join(directory,'result.json'),JSON.stringify({browserClosed:true,passed:fixed,backendVerified:false,pageErrors:[],cases}));
 await writeFile(join(directory,'dataset-merge-ui-ledger.json'),JSON.stringify({namespace:input.namespace,businessWrites:0,browserClosed:true}));
 if(!fixed)process.exit(3);console.log(JSON.stringify({namespace:input.namespace,baseUrl:input.baseUrl,actual:${JSON.stringify(expected)}}));
}else if(role==='cleanup'){await writeFile(process.env.TRACE+'.cleaned',input.namespace)}
else if(role==='verify'){let stopped=false;try{await fetch(input.baseUrl+'/ready')}catch{stopped=true}console.log(JSON.stringify({namespace:input.namespace,empty:stopped,mode:'read-only',createdResources:0}));}
`

test('controller store runner effect recovery accepts upgraded runner and preserves old clean attempt', {skip:process.platform!=='win32',timeout:180000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'sg20-upgrade-integration-')),source=join(root,'source');await mkdir(source)
 await writeFile(join(source,'fixture.mjs'),child)
 for(const args of [['init','-q'],['config','user.name','Test'],['config','user.email','test@example.invalid'],['add','.'],['commit','-qm','fixture']])await exec('git',args,{cwd:source})
 const {stdout}=await exec('git',['rev-parse','HEAD'],{cwd:source})
 const candidate=await freezeCandidate({repository:source,baseCommit:stdout.trim(),generation:1,requirementDigest:'a'.repeat(64)})
 const trace=join(root,'trace'),fixed=join(root,'fixed'),reports=join(root,'reports'),profile=join(root,'profile.json');await writeFile(trace,'')
 await writeFile(profile,JSON.stringify({environment:'uat',env:{TRACE:trace,FIXED:fixed,REPORTS:reports}}))
 const command=role=>({executable:process.execPath,args:['fixture.mjs',role]})
 const config={version:'sg20-seven-ui-hosted-v2',sharedDataProfilePath:profile,prepareSteps:[command('prepare')],service:{...command('service'),args:['fixture.mjs','service','127.0.0.1','{port}'],readyPath:'/ready'},scenarios:[{...command('scenario'),id:'dataset-merge-ui',description:'isolated admission fixture'}],cleanup:command('cleanup'),verifyCleanup:command('verify')}
 trackTestService(t,config.service,root)
 const options={root:join(root,'acceptance'),tempRoot:join(root,'tmp'),config};let runner=createTaskLocalAcceptanceRunner(options)
 const plan={cases:[{criterionId:'criterion-1',scenarioId:'dataset-merge-ui',expected,steps:['isolated integration path'],parameters:{}}]}
 const dbPath=join(root,'control.db'),store=await openExecutionStore({dbPath,instanceId:'upgrade-test',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true});let controller
 t.after(async()=>{await controller?.close();await store.close()})
 const uiScript=new URL('../scripts/local-acceptance-dataset-merge-ui.mjs',import.meta.url),uiBytes=await readFile(uiScript),fixtureHash=createHash('sha256').update(uiBytes).digest('hex')
 assert.match(fixtureHash,/^[a-f0-9]{64}$/)
 const recoveryConfig=join(root,'recovery-config.json');await writeFile(recoveryConfig,JSON.stringify({taskId:'task',uatEnvironment:'uat3',evidenceRoot:reports}))
 const shape={type:'object'};let prepares=0,dispatches=0,lastBinding
 const workflow={id:'upgrade-workflow',version:'22',nodes:[
 {id:'plan-local-acceptance',version:'1',executor:'code',allowedEffects:['pure'],inputSchema:shape,outputSchema:shape,mapInput:({requirement})=>requirement,execute:async()=>({candidate,plan})},
 {id:'prepare-local-acceptance',version:'1',executor:'code',allowedEffects:['workspace.prepare'],inputSchema:shape,outputSchema:shape,mapInput:({previousOutput})=>previousOutput,retryAcceptance:(prepared,context)=>runner.retryPrepared(prepared,context),execute:async({input,taskId,runId,generation})=>{prepares++;return{...input,localPrepared:await runner.prepare({candidate:input.candidate,plan:input.plan,taskId,runId,generation,uatEnvironment:'uat3'})}}},
 {id:'run-local-acceptance',version:'1',executor:'code',allowedEffects:['external.operation'],inputSchema:shape,outputSchema:shape,mapInput:({previousOutput})=>previousOutput,execute:async({input,taskId,runId,generation,requirementDigest,perform})=>{const prepared={...input.localPrepared,action:'external',workflowKind:'local-acceptance',taskId,runId,generation,requirementDigest,resourceKey:'external:local-acceptance:shared-uat'};return{...input,localPrepared:prepared,localAcceptance:await perform({action:'external',prepared})}}},
 {id:'finalize-local-acceptance',version:'1',executor:'code',allowedEffects:['read'],inputSchema:shape,outputSchema:shape,mapInput:({previousOutput})=>previousOutput,execute:async({input})=>{await runner.assertPassed(input.localPrepared,input.localAcceptance);return input}}
 ]}
 const gateway=createExecutionDelivery({store,artifacts,authorize:async()=>null,authorizeExternal:async()=>({principalId:'owner',authorizationRef:'isolated-approved'}),externalAdapter:{execute:async(prepared)=>{dispatches++;return{...await runner.execute(prepared),status:'succeeded'}},reconcile:async(prepared)=>({...await runner.readReceipt(prepared),status:'succeeded'})}})
 const delivery={execute:(request,context)=>{lastBinding=request.binding;return gateway.execute(request,context)}}
 const checkedStore={query:q=>store.query(q),command:async command=>{
  if(command.kind==='node.retry-local-acceptance')await assert.rejects(store.command({...command,id:command.id+':foreign-candidate',args:{...command.args,prepared:{...command.args.prepared,candidateDigest:'b'.repeat(64)}}}),{code:'ACCEPTANCE_CLEAN_RETRY_SCOPE_CHANGED'})
  return store.command(command)
 }}
 controller=createExecutionController({store:checkedStore,artifacts,workflows:[workflow],delivery})
 const def=defineExecutionWorkflow(workflow),input={request:'isolated SG20 recovery integration',acceptanceCriteria:['unchanged fixture contract']},requirement=await artifacts.put(input)
 await store.command({id:'register',kind:'workflow.register',args:{workflowId:workflow.id,digest:def.digest,definitionVersion:'22',config:{kind:'engineering',taskId:'task',runId:'run',localAcceptanceConfig:{version:config.version,scenarios:[{args:[uiScript.pathname.slice(1),null,null,recoveryConfig]}]}}}})
 await store.command({id:'task',kind:'task.accept',args:{taskId:'task',requirementRevision:1,requirementRef:requirement.ref,sessionId:'owner',criteria:input.acceptanceCriteria,sourceKey:'source',eventKey:'source'}})
 await store.command({id:'plan',kind:'task.plan.initialize',args:{taskId:'task',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,stages:[{stageId:'engineering',workflowId:workflow.id,workflowDigest:def.digest,unavailableReason:null,requirementRef:requirement.ref,gate:'none'}]}})
 await controller.createRun({commandId:'create',taskId:'task',runId:'run',workflowId:workflow.id,input,stageBinding:{planRevision:1,stageId:'engineering',attempt:1,expectedControlRevision:1}})
 const before=await controller.whenIdle('run');assert.equal(before.run.status,'waiting',JSON.stringify(before));assert.equal(before.nodes[3].waitReason.reference,'LOCAL_ACCEPTANCE_FAILED')
 const effects=await store.query({kind:'effect.list',runId:'run'});assert.equal(effects.length,1);const oldEffect=effects[0]
 const output=await artifacts.read(before.nodes[2].outputRef),oldPrepared=output.localPrepared,oldReceipt=await readFile(join(dirname(oldPrepared.directory),'receipt.json'),'utf8')
 assert.equal(output.localAcceptance.cleanup.createdResources,0);assert.equal(output.localAcceptance.cleanup.processStopped,true)
 // Simulate a supported installed runner upgrade; persisted workflow business inputs stay unchanged.
 runner=createTaskLocalAcceptanceRunner({...options,config:{...config,version:'sg20-seven-ui-hosted-v2-repaired'}})
 assert.notEqual(runner.identity,oldPrepared.runnerIdentity);await writeFile(fixed,'fixed')
 const gate=await controller.inspectNodeRecovery('run');assert.equal(gate.repairable,true,JSON.stringify(gate));assert.equal(gate.readonlyFixtureRetry,true)
 await controller.recover({commandId:'upgrade-recovery',runId:'run'})
 const after=await controller.whenIdle('run');assert.equal(after.run.status,'succeeded',JSON.stringify(after))
 const current=await artifacts.read(after.nodes[2].outputRef);assert.equal(current.localPrepared.runnerIdentity,runner.identity);assert.equal(current.localAcceptance.passed,true)
 const finalEffects=await store.query({kind:'effect.list',runId:'run'});assert.equal(finalEffects.length,2);assert.deepEqual(await store.query({kind:'effect.get',effectId:oldEffect.effectId}),oldEffect)
 assert.equal(await readFile(join(dirname(oldPrepared.directory),'receipt.json'),'utf8'),oldReceipt)
 assert.equal(prepares,1);assert.equal(dispatches,2)
 await gateway.execute({binding:lastBinding,action:'external',prepared:current.localPrepared});assert.equal(dispatches,2)
 const events=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(events.filter(e=>e.role==='scenario').length,2)
 assert.equal(createHash('sha256').update(await readFile(uiScript)).digest('hex'),fixtureHash)
 assert.equal(current.localPrepared.candidateDigest,oldPrepared.candidateDigest);assert.equal(current.localPrepared.planDigest,oldPrepared.planDigest)
})