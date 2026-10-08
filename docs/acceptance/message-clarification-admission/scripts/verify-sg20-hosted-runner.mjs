import assert from 'node:assert/strict'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { createLocalAcceptanceRunner } from '../../../../packages/dingtalk-dsh-assistant/execution-local-acceptance.js'
import { executionDigest } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
const [inputPath,outputPath,mode]=process.argv.slice(2),directory=resolve(outputPath)
assert.ok(inputPath&&outputPath&&['--check','--execute'].includes(mode))
const input=JSON.parse(await readFile(resolve(inputPath),'utf8')),record=input.record,taskId='task-83c651ebdbdb77584a06d1fcb6b9e255'
assert.equal(record.taskId,taskId);assert.equal(record.uatEnvironment,'uat3');assert.equal(input.outputs['verify-candidate'].verification.passed,true)
await mkdir(directory,{recursive:true})
const scope={taskId,uatEnvironment:'uat3',requestDigest:executionDigest({request:record.input.request,acceptanceCriteria:record.input.acceptanceCriteria})}
const script=resolve('scripts/local-acceptance-dataset-merge-ui.mjs'),configPath=join(directory,'ui-config.json'),profilePath=join(directory,'fixture-profile.json')
const uiConfig={taskId,uatEnvironment:'uat3',evidenceRoot:join(directory,'evidence'),playwrightModule:'D:/baibu-agent/scratchpad/process-draft-import-e2e/node_modules/playwright-core/index.mjs',nodeExecutable:'D:/soft/node-v22.13.0/node.exe',yarnCli:'C:/Users/64554/AppData/Local/node/corepack/v1/yarn/1.22.21/bin/yarn.js'}
await writeFile(configPath,JSON.stringify(uiConfig,null,2));await writeFile(profilePath,JSON.stringify({environment:'uat',env:{SG20_FIXTURE_SCOPE:'sg20-private-fixture-marker-20261008'}}))
const command=mode=>({executable:process.execPath,args:[script,mode,'--config',configPath]})
const config={version:'sg20-seven-ui-hosted-v2',sharedDataProfilePath:profilePath,generatedOutputDirectories:['node_modules'],prepareSteps:[command('initialize'),command('prepare')],service:{...command('serve'),args:[...command('serve').args,'--host','127.0.0.1','--port','{port}'],readyPath:'/ready'},scenarios:[{...command('execute'),id:'dataset-merge-ui',description:'真实候选组件七项交互：选择回填、权重列、折叠面板、筛选横滚、步骤条、提示、说明布局；API/list为明确fixture'}],cleanup:command('cleanup'),verifyCleanup:command('verify-cleanup'),instructions:'对应本Task原文七项纯UI交互，真实候选组件与明确API/list fixture；不要求未变更的后端功能，backendVerified:false如实记录。'}
const expected=JSON.stringify({uiContract:true,coverage:'candidate-ui-with-explicit-api-and-list-fixtures',backendVerified:false})
const plan={cases:[{criterionId:'sg20-seven-ui',scenarioId:'dataset-merge-ui',steps:['启动冻结候选真实组件loopback服务','同一服务URL执行七项UI断言','关闭浏览器并核验runner清理'],expected,parameters:{}}]}
const binding={scope,localAcceptance:config};await writeFile(join(directory,'task-local-acceptance.json'),JSON.stringify(binding,null,2))
const runner=createLocalAcceptanceRunner({root:join(directory,'runs'),config})
if(mode==='--check'){console.log(JSON.stringify({scope,runnerIdentity:runner.identity,checked:true}));process.exit(0)}
const prepared=await runner.prepare({candidate:input.outputs['verify-candidate'].candidate,plan,taskId,runId:input.runId,generation:input.generation,uatEnvironment:'uat3'})
await writeFile(join(directory,'prepared.json'),JSON.stringify(prepared,null,2))
const result=await runner.execute(prepared);await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scope,passed:result.passed,failureCode:result.failureCode,baseUrl:result.baseUrl,phases:result.phases,cleanup:result.cleanup,checks:result.checks}));assert.equal(result.passed,true,JSON.stringify(result))
assert.equal(await runner.assertPassed(prepared,result),true)
assert.deepEqual(await runner.execute(prepared),result,'receipt-only recovery must not repeat work')
await assert.rejects(runner.execute({...prepared,uatEnvironment:'uat2'}),/PREPARED_MISMATCH/)
console.log(JSON.stringify({receiptIdempotent:true,wrongContextRejected:true,sourceManifestVerified:true}))
