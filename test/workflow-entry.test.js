import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyWorkflowActivation } from '../packages/dingtalk-dsh-assistant/resident.js'

test('配置不能替代持久active/workflow与封存证明', async () => {
  const store = { getGroup: () => ({ messages: [], outbox: [], coordinationRequests: {} }), listTasks: () => [] }
  for (const state of [null, { state: 'draining', engine: 'workflow', legacySealRef: 'proof' }, { state: 'active', engine: 'workflow' }, { state: 'active', engine: 'legacy', legacySealRef: 'proof' }]) {
    await assert.rejects(verifyWorkflowActivation(store, { query: async () => state }, ['g']), /workflow_group_not_activated/)
  }
  await verifyWorkflowActivation(store, { query: async () => ({ state: 'active', engine: 'workflow', legacySealRef: 'proof' }) }, ['g'])
})

test('账本已激活但旧任务/消息/通知/协调未排空也禁止双引擎启动', async () => {
  const control = { query: async () => ({ state: 'active', engine: 'workflow', legacySealRef: 'proof' }) }
  const empty = { messages: [], outbox: [], coordinationRequests: {} }
  for (const [group, tasks] of [[empty, [{ groupId: 'g', state: 'running' }]], [{ ...empty, messages: [{ routingStatus: 'pending' }] }, []], [{ ...empty, outbox: [{ status: 'pending', sendAttempt: 1 }] }, []], [{ ...empty, coordinationRequests: { one: { status: 'exhausted' } } }, []]]) {
    await assert.rejects(verifyWorkflowActivation({ getGroup: () => group, listTasks: () => tasks }, control, ['g']), /workflow_legacy_not_drained/)
  }
})

test('固定相邻seal不能因workflow配置删除而恢复旧入口，sealed必须离线续接',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto')
 const {verifyResidentWorkflowSeal,inject}=await import('../packages/dingtalk-dsh-assistant/resident.js')
 const root=await mkdtemp(join(tmpdir(),'workflow-seal-entry-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const ctx={storageDomain:{config:{backend:'json'}},storage:{backend:{get:()=>({root})}}}
 assert.equal((await verifyResidentWorkflowSeal(ctx)).seal,null)
 const snapshot=JSON.stringify({unit:{name:'dingtalk_dsh_assistant',version:9},tables:{groups:{g:{groupId:'g'}},tasks:{}}}),snapshotPath=join(root,'snapshot.json'),dbPath=join(root,'control.db')
 await writeFile(snapshotPath,snapshot)
 const journal={version:1,phase:'sealed',groupIds:['g'],snapshotPath,legacySha256:createHash('sha256').update(snapshot).digest('hex'),instanceId:'i',dbPath}
 const sealPath=join(root,'dingtalk_dsh_assistant.workflow-seal.json');await writeFile(sealPath,JSON.stringify(journal))
 await assert.rejects(verifyResidentWorkflowSeal(ctx),/workflow_sealed_group_configuration_required/)
 const config={groupIds:['g'],dbPath,instanceId:'i'}
 await assert.rejects(verifyResidentWorkflowSeal(ctx,config),/workflow_cutover_requires_offline_resume/)
 await writeFile(sealPath,JSON.stringify({...journal,phase:'active'}));assert.equal((await verifyResidentWorkflowSeal(ctx,config)).seal.blockLegacy,true)
 await assert.rejects(verifyResidentWorkflowSeal(ctx,{...config,instanceId:'wrong'}),/workflow_seal_instance_mismatch/)
 for(const service of ['storage','agentLoop','sessions','sessionProjections','tools'])assert.ok(inject.includes(service))
})
