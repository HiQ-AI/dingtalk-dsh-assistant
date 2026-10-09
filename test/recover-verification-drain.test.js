import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { executionDigest, openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { assertVerificationDrainScope } from '../docs/acceptance/topic-context-completeness/scripts/recover-verification-drain.mjs'
test('排空桥与正式Owner使用同一工件路径，workspace根不能重复tasks',async()=>{
 const source=await readFile(new URL('../docs/acceptance/topic-context-completeness/scripts/recover-verification-drain.mjs',import.meta.url),'utf8')
 const roots=[...source.matchAll(/taskWorkspaceRoot:'([^']+)'/g)].map(m=>m[1]);assert.equal(roots.length,2)
 const ref='tasks/task-fixture/sha256-'+ 'a'.repeat(64)+'.json'
 for(const taskWorkspaceRoot of roots){
  const artifacts=await openExecutionArtifacts({directory:resolve('docs/tmp'),taskWorkspaceRoot})
  assert.equal(artifacts.locate(ref),resolve('D:/baibu-agent/tasks/task-fixture/work/artifacts/sha256-'+ 'a'.repeat(64)+'.json'))
 }
})
function fixture(){
 const manifest={taskId:'task-83c651ebdbdb77584a06d1fcb6b9e255',runId:'run-01a4fc72219b513a3f78e7cdb5be55699e448d6b63b97d3a65f8fcf60dc4d03f',nodeRunId:'b96e85bf-6b4c-4c19-b7ed-97bbce3a6ce8',generation:6,leaseEpoch:1,inputDigest:'a'.repeat(64),inputRef:'sha256-'+ 'a'.repeat(64)+'.json',outputRef:null,workflowDigest:'b'.repeat(64),runRevision:12,requirementRef:'source',otherNodesDigest:executionDigest([]),maintenanceId:'drain-test',maintenanceRevision:521}
 const node={nodeRunId:manifest.nodeRunId,nodeId:'verify-candidate',executor:'code',status:'waiting',generation:6,leaseEpoch:1,inputDigest:manifest.inputDigest,inputRef:manifest.inputRef,outputRef:null,drained:false,waitReason:{reference:'controller-restarted'}}
 return {manifest,current:{run:{runId:manifest.runId,status:'waiting',workflowDigest:manifest.workflowDigest,revision:12,requirementRef:'source'},nodes:[node],pendingInputCount:0},maintenance:{active:true,phase:'draining',maintenanceId:'drain-test',revision:521,busy:{nodes:1,owners:0,effects:0,messages:0}}}
}
test('检查排空桥仅接纳精确旧节点，原生排空后仍waiting且维护busy0',()=>{
 const {current,maintenance,manifest}=fixture()
 assert.equal(assertVerificationDrainScope(current,maintenance,manifest).drained,false)
 current.nodes[0].drained=true;current.nodes[0].waitReason.reference='external-check-interrupted';maintenance.busy.nodes=0
 assert.equal(assertVerificationDrainScope(current,maintenance,manifest,true).status,'waiting')
})
for(const [name,mutate,code] of [
 ['跨Task',x=>x.manifest.taskId='foreign','DRAIN_TASK_SCOPE_CHANGED'],
 ['输入漂移',x=>x.current.nodes[0].inputDigest='c'.repeat(64),'DRAIN_NODE_CAS_CHANGED'],
 ['新代',x=>x.current.nodes[0].generation++,'DRAIN_NODE_CAS_CHANGED'],
 ['运行版本',x=>x.current.run.revision++,'DRAIN_RUN_CAS_CHANGED'],
 ['旧维护',x=>x.maintenance.revision++,'DRAIN_MAINTENANCE_CHANGED'],
 ['其他活跃效果',x=>x.maintenance.busy.effects++,'DRAIN_MAINTENANCE_CHANGED'],
 ['未维护',x=>x.maintenance.active=false,'DRAIN_MAINTENANCE_CHANGED'],
 ['有待消费输入',x=>x.current.pendingInputCount++,'DRAIN_TASK_SCOPE_CHANGED'],
 ['其他失败',x=>x.current.nodes[0].waitReason.reference='provider-failed','DRAIN_WAIT_CHANGED'],
 ['前缀漂移',x=>x.manifest.otherNodesDigest='d'.repeat(64),'DRAIN_PREFIX_CHANGED'],
])test('检查排空桥拒绝'+name,()=>{const x=fixture();mutate(x);assert.throws(()=>assertVerificationDrainScope(x.current,x.maintenance,x.manifest),{code})})

test('旧事故适用性不把正常Owner或后续节点当作待修排空',async()=>{
 const {verificationDrainEligible}=await import('../docs/acceptance/topic-context-completeness/scripts/recover-verification-drain.mjs')
 const f=fixture();assert.equal(verificationDrainEligible(f.current,f.maintenance),true)
 for(const change of [x=>x.current.nodes[0].drained=true,x=>x.current.nodes[0].status='succeeded',x=>x.current.nodes[0].leaseEpoch++,x=>x.maintenance.busy.owners++,x=>x.maintenance.busy.nodes++,x=>x.current.nodes[0].nodeRunId='later-node']){
  const x=structuredClone(f);change(x);assert.equal(verificationDrainEligible(x.current,x.maintenance),false)
 }
})
