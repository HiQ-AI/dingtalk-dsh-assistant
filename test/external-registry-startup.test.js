import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openExecutionStore} from '../packages/dingtalk-dsh-assistant/execution-store.js'
import {openWorkflowService} from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import {createReleaseTaskWorkflow,externalWorkflowOwnerContract} from '../packages/dingtalk-dsh-assistant/task-release-workflows.js'
import {defineExecutionWorkflow} from '../packages/dingtalk-dsh-assistant/execution-controller.js'
test('startup retains historical identical external digest without replaying changed registry metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'external-registry-startup-')),config={groupIds:['g'],ownerActorId:'owner',dbPath:join(root,'control.db'),artifactDirectory:join(root,'artifacts'),instanceId:'startup'}
 let calls=0,service;const deny=async()=>{calls++;throw Error('EXTERNAL_NOT_EXPECTED')}
 const adapter={id:'startup-release',version:'1',rulesDigest:'a'.repeat(64),inspect:deny,prepareOperation:deny}
 const workflow={...createReleaseTaskWorkflow({kind:'uat-deployment',adapter}),ownerContract:externalWorkflowOwnerContract},definition=defineExecutionWorkflow(workflow)
 const record={workflowId:workflow.id,definitionVersion:workflow.version,digest:definition.digest,config:{kind:'external',registryVersion:'1',ownerContractVersion:externalWorkflowOwnerContract.version,adapterId:adapter.id,adapterVersion:adapter.version,rulesDigest:adapter.rulesDigest}}
 let store=await openExecutionStore({dbPath:config.dbPath,instanceId:config.instanceId,initialize:true});await mkdir(config.artifactDirectory)
 await store.command({id:'workflow:'+record.digest,kind:'workflow.register',args:record});await store.close()
 t.after(async()=>{await service?.close();await store?.close();await rm(root,{recursive:true,force:true})})
 const external={releaseAdapters:{'uat-deployment':adapter},operationAdapter:{execute:deny,reconcile:deny},authorizeExternal:deny,prepareRequirement:deny}
 const open=()=>openWorkflowService({ctx:{},config,external,legacy:{getAgentConfig:()=>({provider:'test',model:'test'})},taskOwnerSessions:{async close(){}}})
 service=await open();assert.deepEqual((await service.execution.store.query({kind:'workflow.list'})).find(x=>x.digest===record.digest),record);assert.equal(calls,0)
 await service.close();service=await open();assert.deepEqual((await service.execution.store.query({kind:'workflow.list'})).find(x=>x.digest===record.digest),record);assert.equal(calls,0)
 await service.close();adapter.rulesDigest='b'.repeat(64);service=await open();const records=await service.execution.store.query({kind:'workflow.list'});assert.ok(records.some(x=>x.workflowId===workflow.id&&x.digest!==record.digest));assert.deepEqual(records.find(x=>x.digest===record.digest),record);assert.equal(calls,0)
})