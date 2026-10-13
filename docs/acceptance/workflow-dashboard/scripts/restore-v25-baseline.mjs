import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createEngineeringRegistry } from '../../../../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { defineExecutionWorkflow } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'
const fixture=JSON.parse(await readFile(new URL('../../../tmp/workflow-dashboard/v25-frozen-baseline.json',import.meta.url),'utf8'))
assert.equal(fixture.baseCommit,'44646d2056375b32ebf2ed2f7812d946473f9722')
let writes=0
const store={command(){writes++;throw Error('RESTORE_MUST_NOT_WRITE')},query(input){if(input.kind==='workflow.list')return [fixture.record];if(input.kind==='run')return {run:{runId:fixture.record.config.runId,status:'succeeded',workflowDigest:fixture.record.digest},nodes:[]};if(input.kind==='effect.list')return [];throw Error('UNEXPECTED_QUERY:'+input.kind)}}
const registry=createEngineeringRegistry({...fixture.options,modelConfig:()=>({provider:'test',model:'test'})})
const restored=await registry.restore(store)
assert.equal(restored.length,1)
assert.equal(restored[0].version,'25')
assert.equal(defineExecutionWorkflow(restored[0]).digest,fixture.digest)
assert.equal(writes,0)
const sources={}
for(const name of ['workflow-engineering.js','task-workflow.js','execution-controller.js'])sources[name]=createHash('sha256').update(await readFile(new URL(`../../../../packages/dingtalk-dsh-assistant/${name}`,import.meta.url))).digest('hex')
const result={verifiedAt:new Date().toISOString(),status:'PASS',baseCommit:fixture.baseCommit,digest:fixture.digest,version:restored[0].version,nodes:restored[0].nodes.length,persistentWrites:writes,sources}
await writeFile(new URL('../../../tmp/workflow-dashboard/v25-current-restore.json',import.meta.url),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
