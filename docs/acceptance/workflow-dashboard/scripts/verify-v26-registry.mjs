// 隔离的注册/重启验证；不执行工作流节点，不连接业务数据库。
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createEngineeringRegistry } from '../../../../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { defineExecutionWorkflow } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'

const root=fileURLToPath(new URL('../../../../',import.meta.url))
const output=join(root,'docs/tmp/workflow-dashboard')
const fixture=JSON.parse(await readFile(join(output,'v25-frozen-baseline.json'),'utf8'))
const directory=await mkdtemp(join(output,'v26-registry-'))
const cases=[]
const options={...fixture.options,modelConfig:()=>({provider:'test',model:'test'})}
const query={scope:{actorId:'owner',conversationId:'fixture-conversation',queryCapabilityIdentity:'fixture-query-v1',resourceIds:[],databaseIds:['fixture-db'],statusIds:[]},databases:[{id:'fixture-db',dialect:'postgresql',purpose:'隔离目录夹具',schemas:['public']}]}
for(const mode of ['omitted','none','database']){
  const store=await openExecutionStore({dbPath:join(directory,`${mode}.db`),instanceId:`v26-${mode}`,initialize:true})
  let calls=0,workflow
  const taskId=`v26-${mode}`
  const registry=createEngineeringRegistry({...options,...(mode==='omitted'?{}:{databaseQueryContext:async id=>{calls++;assert.equal(id,taskId);return mode==='none'?null:structuredClone(query)}})})
  try{
    await registry.restore(store)
    await registry.prepareTask({taskId,arguments:{repositoryId:'repo',uatEnvironment:'uat2',objective:'隔离验证工程配置冻结'}},{commandId:`v26-${mode}`,run:{actorId:'owner'},unit:{}},{registerWorkflow(value){workflow=value}})
    const record=(await store.query({kind:'workflow.list'}))[0]
    assert.equal(record.definitionVersion,'26');assert.equal(workflow.version,'26')
    assert.equal(workflow.nodes.length,16)
    const analysis=workflow.nodes.find(node=>node.id==='inspect-and-propose')
    const apply=workflow.nodes.find(node=>node.id==='apply-changes')
    assert.deepEqual(apply.allowedTools,['engineering_repo_inspect','engineering_apply_edits'])
    assert.equal(apply.version,'11')
    assert.equal(analysis.allowedTools.includes('query_readonly_database'),mode==='database')
    assert.equal(calls,mode==='omitted'?0:1)
    const input=analysis.mapInput({requirement:record.config.input,previousOutput:null,dependencyOutputs:{'prepare-generation':{requirement:record.config.input}}})
    if(mode==='database'){
      assert.deepEqual(input.scope,query.scope)
      assert.deepEqual(input.databaseCatalog,query.databases)
      assert.deepEqual(record.config.databaseQuery,query)
    }else{
      assert.equal(Object.hasOwn(input,'scope'),false)
      assert.equal(Object.hasOwn(input,'databaseCatalog'),false)
    }
    let writes=0,latestReads=0
    const readonly={command(){writes++;throw Error('RESTORE_MUST_NOT_WRITE')},query(value){if(value.kind==='workflow.list')return [record];if(value.kind==='run')return {run:{runId:record.config.runId,status:'succeeded',workflowDigest:record.digest},nodes:[]};if(value.kind==='effect.list')return [];throw Error('UNEXPECTED_QUERY:'+value.kind)}}
    const restored=await createEngineeringRegistry({...options,databaseQueryContext:async()=>{latestReads++;throw Error('FROZEN_RESTORE_MUST_NOT_READ_CURRENT_CATALOG')}}).restore(readonly)
    assert.equal(restored.length,1);assert.equal(defineExecutionWorkflow(restored[0]).digest,record.digest)
    assert.equal(writes,0);assert.equal(latestReads,0)
    if(mode==='database'){
      const tampered=structuredClone(record)
      tampered.config.databaseQuery.scope.databaseIds.push('extra-db')
      const changed={...readonly,query(value){return value.kind==='workflow.list'?[tampered]:readonly.query(value)}}
      await assert.rejects(createEngineeringRegistry(options).restore(changed),{code:'ENGINEERING_DEFINITION_DRIFT'})
    }
    cases.push({mode,status:'PASS',version:workflow.version,nodes:workflow.nodes.length,digest:record.digest,registeredQueryReads:calls,restoreLatestCatalogReads:latestReads,restoreWrites:writes,analysisTools:analysis.allowedTools,applyTools:apply.allowedTools,scopeTamper:mode==='database'?'REJECTED':'NOT_APPLICABLE'})
  }finally{await store.close()}
}
const sources={}
for(const name of ['workflow-engineering.js','task-workflow.js','execution-controller.js'])sources[name]=createHash('sha256').update(await readFile(join(root,'packages/dingtalk-dsh-assistant',name))).digest('hex')
const result={verifiedAt:new Date().toISOString(),status:'PASS',directory,sources,cases,boundary:'仅 registry 注册、输入映射及 succeeded 历史定义重建；未执行 DB 查询、业务节点、reset 或 reissue/rebuild。'}
await writeFile(join(output,'v26-registry-results.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
