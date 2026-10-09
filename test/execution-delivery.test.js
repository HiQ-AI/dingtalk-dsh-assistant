import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery, isTerminalUatBuildFailure } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExecutionController, defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delivery-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'delivery', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  t.after(() => store.close())
  const requirementRef = (await artifacts.put({ request: 'synthetic delivery' })).ref
  await store.command({ id: 'create', kind: 'run.create', args: { runId: 'run', taskId: 'task', workflowId: 'git', workflowDigest: 'a'.repeat(64), requirementRef, nodes: [{ nodeId: 'commit', nodeVersion: '1', executor: 'code', inputRef: 'input.json', inputDigest: 'b'.repeat(64) }] } })
  const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: { runId: 'run', nodeId: 'commit', expectedGeneration: 1, expectedLeaseEpoch: 0 } })
  let sent = 0, authorized = 0
  const adapter = { executeCommit: async () => { sent++; return { status: 'succeeded', commitId: 'c'.repeat(40) } }, reconcileCommit: async () => ({ status: 'succeeded', commitId: 'c'.repeat(40) }), ...overrides.adapter }
  const authorize = overrides.authorize ?? (async () => { authorized++; return { principalId: 'synthetic', authorizationRef: 'task-grant' } })
  const gateway = createExecutionDelivery({ store, artifacts, adapter, workspaceAdapter: overrides.workspaceAdapter, authorize })
  const request = { binding: { ...binding, requirementDigest: 'a'.repeat(64) }, action: 'commit', prepared: { action: 'commit', generation: 1, requirementDigest: 'a'.repeat(64), repository: 'synthetic-repo', remote: 'synthetic-remote', ref: 'refs/heads/task', candidateDigest: 'd'.repeat(64) } }
  return { store, artifacts, gateway, request, requirementRef, counts: () => ({ sent, authorized }) }
}

test('效果网关同操作并发/重投只执行一次，授权不逐步骤重复索取', async t => {
  const f = await fixture(t)
  const results = await Promise.all([f.gateway.execute(f.request), f.gateway.execute(f.request)])
  assert.ok(results.every(r => r.state === 'succeeded'))
  await f.gateway.execute(f.request)
  assert.deepEqual(f.counts(), { sent: 1, authorized: 1 })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, candidateDigest: 'e'.repeat(64) } }), { code: 'DELIVERY_IDENTITY_CONFLICT' })
})

test('仅原生只读待审效果可受信失败收口，CAS阻止落账且重放不重复派发', async t => {
  const f = await fixture(t)
  let dispatched = 0, verified = 0
  const gateway = createExecutionDelivery({ store: f.store, artifacts: f.artifacts,
    authorize: async () => ({ principalId: 'owner', authorizationRef: 'authorized' }),
    authorizeExternal: async () => ({ principalId: 'owner', authorizationRef: 'readonly' }),
    externalAdapter: { execute: async () => { dispatched++; return { status: 'unknown', reason: 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED' } },
      closeReadonlyApproval: async () => { verified++; return { status: 'failed', reason: 'APPROVAL_CHANNEL_SUPERSEDED', result: { readonly: true } } } } })
  const prepared = { action: 'external', workflowKind: 'data-change', stage: 'approval-gate', runId: 'run',
    generation: 1, requirementDigest: 'a'.repeat(64), resourceKey: 'external:bytebase:app', intent: { approvalSource: 'bytebase' } }
  const effect = await gateway.execute({ binding: f.request.binding, action: 'external', prepared })
  await assert.rejects(gateway.closeReadonlyApproval(effect.effectId, { beforeObserve: async () => { throw new Error('CAS changed') } }), /CAS changed/)
  assert.equal((await f.store.query({ kind: 'effect.get', effectId: effect.effectId })).state, 'unknown')
  const closed = await gateway.closeReadonlyApproval(effect.effectId, { beforeObserve: async () => {} })
  assert.equal(closed.state, 'failed')
  assert.equal(closed.result.result.reason, 'APPROVAL_CHANNEL_SUPERSEDED')
  const persisted = await f.artifacts.read(closed.result.evidenceRef)
  assert.equal(persisted.reason, 'APPROVAL_CHANNEL_SUPERSEDED')
  await gateway.closeReadonlyApproval(effect.effectId, { beforeObserve: async () => {} })
  assert.equal(dispatched, 1); assert.equal(verified, 3)
  const write = await f.gateway.execute(f.request)
  await assert.rejects(gateway.closeReadonlyApproval(write.effectId, { beforeObserve: async () => {} }),
    { code: 'DATA_CHANGE_APPROVAL_HANDOFF_EFFECT_UNCONFIRMED' })
})

test('缺少授权和generation不符不调用写适配器', async t => {
  const f = await fixture(t, { authorize: async () => null })
  await assert.rejects(f.gateway.execute(f.request), { code: 'DELIVERY_NOT_AUTHORIZED' })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, generation: 2 } }), { code: 'DELIVERY_INPUT_INVALID' })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, requirementDigest: 'c'.repeat(64) } }), { code: 'DELIVERY_INPUT_INVALID' })
  assert.equal(f.counts().sent, 0)
})

for (const control of ['stop', 'input', 'revoke']) test(`${control}先提交阻止Git发送资格`, async t => {
  const f = await fixture(t)
  const operation = control === 'stop' ? { kind: 'run.stop', args: { runId: 'run', reason: 'synthetic' } }
    : control === 'input' ? { kind: 'input.accept', args: { runId: 'run', inputId: 'input', sourceKey: 'source', requirementRef: 'changed.json' } }
      : { kind: 'safety.revoke', args: { scope: 'run', key: 'run', reason: 'synthetic revoke' } }
  await f.store.command({ id: 'control', ...operation })
  await assert.rejects(f.gateway.execute(f.request))
  assert.equal(f.counts().sent, 0)
})

test('效果已发生但适配器回执丢失，只对账不重复发送', async t => {
  let sent = 0
  const f = await fixture(t, { adapter: { executeCommit: async () => { sent++; throw Object.assign(new Error('lost ACK'), { code: 'LOST_ACK' }) } } })
  const unknown = await f.gateway.execute(f.request)
  assert.equal(unknown.state, 'unknown')
  const recovered = await f.gateway.execute(f.request)
  assert.equal(recovered.state, 'succeeded')
  assert.equal(sent, 1)
})

test('Git能力仅给显式注册网关的受信code节点，Agent不能领取Git能力', () => {
  const node = { id: 'git', version: '1', executor: 'code', allowedEffects: ['git.commit'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => ({}) }
  assert.throws(() => createExecutionController({ workflows: [{ id: 'git', version: '1', nodes: [node] }] }), { code: 'DELIVERY_ADAPTER_REQUIRED' })
  assert.throws(() => defineExecutionWorkflow({ id: 'git', version: '1', nodes: [{ ...node, executor: 'agent' }] }), { code: 'EFFECT_NOT_ADMITTED' })
})

for (const control of ['stop', 'input', 'revoke']) test(`${control}先落账时不能创建受管目录`, async t => {
  let creates = 0
  const f = await fixture(t, { workspaceAdapter: { execute: async () => { creates++; return { status: 'succeeded' } }, reconcile: async () => ({ status: 'unknown' }) } })
  const operation = control === 'stop' ? { kind: 'run.stop', args: { runId: 'run', reason: 'synthetic' } }
    : control === 'input' ? { kind: 'input.accept', args: { runId: 'run', inputId: 'input', sourceKey: 'source', requirementRef: 'changed.json' } }
      : { kind: 'safety.revoke', args: { scope: 'run', key: 'run', reason: 'synthetic revoke' } }
  await f.store.command({ id: 'control', ...operation })
  await assert.rejects(f.gateway.execute({ binding: f.request.binding, action: 'workspace', prepared: { action: 'workspace', runId: 'run', generation: 1, requirementDigest: 'a'.repeat(64), directory: 'synthetic' } }))
  assert.equal(creates, 0)
})

test('受管目录归属不同run，即使代际与需求相同也不得创建', async t => {
  let creates = 0
  const f = await fixture(t, { workspaceAdapter: { execute: async () => { creates++; return { status: 'succeeded' } } } })
  await assert.rejects(f.gateway.execute({ binding: f.request.binding, action: 'workspace', prepared: { action: 'workspace', runId: 'other-run', generation: 1, requirementDigest: 'a'.repeat(64), directory: 'synthetic' } }), { code: 'DELIVERY_INPUT_INVALID' })
  assert.equal(creates, 0)
})

test('历史目录创建成功后路径丢失不能靠重投回执继续认领，也不能重克隆', async t => {
  let creates = 0
  const f = await fixture(t, { workspaceAdapter: { execute: async () => { creates++; return { status: 'succeeded' } }, reconcile: async () => ({ status: 'unknown' }) } })
  const request = { binding: f.request.binding, action: 'workspace', prepared: { action: 'workspace', runId: 'run', generation: 1, requirementDigest: 'a'.repeat(64), directory: 'synthetic' } }
  assert.equal((await f.gateway.execute(request)).state, 'succeeded')
  await assert.rejects(f.gateway.execute(request), { code: 'WORKSPACE_CURRENT_IDENTITY_UNCONFIRMED' })
  assert.equal(creates, 1)
})

test('UAT终态失败必须是同一冻结普通build的完整可信收据',()=>{
 const effect={state:'failed',definition:{action:'external',adapterId:'external-operation',adapterVersion:'1',payload:{workflowKind:'uat-deployment',operation:'build',operationKey:'a'.repeat(64),expected:{commitSha:'b'.repeat(40)}}},result:{result:{status:'failed',reason:'RELEASE_PIPELINE_FAILED',operationKey:'a'.repeat(64),commitSha:'b'.repeat(40),pipelineNumber:319,pipelineStatus:'killed',evidenceRef:'woodpecker:list:319'}}}
 assert.equal(isTerminalUatBuildFailure(effect),true)
 for(const change of [e=>e.state='unknown',e=>e.definition.adapterId='other',e=>e.definition.payload.workflowKind='uat-rebuild',e=>e.definition.payload.operation='rebuild',e=>e.result.result.reason='READ_FAILED',e=>e.result.result.operationKey='c'.repeat(64),e=>e.result.result.commitSha='d'.repeat(40),e=>e.result.result.pipelineNumber=0,e=>e.result.result.pipelineStatus='running',e=>e.result.result.evidenceRef='']){const bad=structuredClone(effect);change(bad);assert.equal(isTerminalUatBuildFailure(bad),false)}
})


test('交付回执按持久 run 归属保存，不接受适配器结果伪造任务归属', async t => {
  const f = await fixture(t, { adapter: { executeCommit: async () => ({ status: 'succeeded', taskId: 'forged-task' }) } })
  const writes = [], put = f.artifacts.put
  f.artifacts.put = async (value, options) => { writes.push(options); return put(value, options) }
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.deepEqual(writes, [{ taskId: 'task', reference: f.requirementRef }])
})

// 隔离历史账夹具：旧版本 candidate-in-place 已重置节点；效果由真实网关写入，绝不接触运行账。
async function incrementalEditFixture(t, mutate = () => {}) {
  const { DatabaseSync } = await import('node:sqlite')
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const hash = text => createHash('sha256').update(text).digest('hex')
  await mkdir(new URL('../docs/tmp/', import.meta.url), { recursive:true })
  const root = await mkdtemp(new URL('../docs/tmp/incremental-edit-', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))
  const dbPath = join(root,'control.db'), artifacts = await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true})
  let store = await openExecutionStore({dbPath,instanceId:'incremental',initialize:true}), count = 0
  const { createManagedEdits } = await import('../packages/dingtalk-dsh-assistant/execution-edit.js')
  const directory=join(root,'workspace');await mkdir(directory);await writeFile(join(directory,'old.txt'),'old')
  const managed=createManagedEdits({workspaceAdapter:{reconcile:async()=>({status:'succeeded'})}})
  const editAdapter={execute:async prepared=>{count++;return managed.execute(prepared)},reconcile:managed.reconcile}
  const authorize = async()=>({principalId:'host',authorizationRef:'original-task-requirement'})
  const gateway = () => createExecutionDelivery({store,artifacts,editAdapter,authorize})
  const requirementRef = (await artifacts.put({request:'synthetic original'})).ref
  await store.command({id:'create',kind:'run.create',args:{runId:'repair-run',taskId:'repair-task',workflowId:'task-engineering-fixture',workflowDigest:'a'.repeat(64),requirementRef,nodes:[{nodeId:'apply-changes',nodeVersion:'6',executor:'code',inputRef:'old-input.json',inputDigest:'b'.repeat(64)}]}})
  const oldBinding=(await store.command({id:'first-claim',kind:'node.claim',args:{runId:'repair-run',nodeId:'apply-changes',expectedGeneration:1,expectedLeaseEpoch:0}})).result.binding
  const prepared=await managed.prepare({workspace:{action:'workspace',runId:'repair-run',generation:1,requirementDigest:'a'.repeat(64),directory},changes:[{path:'old.txt',expectedHash:hash('old'),content:'first'}]})
  const old=await gateway().execute({binding:{...oldBinding,requirementDigest:'a'.repeat(64)},action:'edit',prepared})
  await store.close()
  const db=new DatabaseSync(dbPath)
  const repair={runId:'repair-run',taskId:'repair-task',generation:1,nextGeneration:1,workflowDigest:'a'.repeat(64),mode:'candidate-in-place',invalidated:[{nodeRunId:oldBinding.nodeRunId,leaseEpoch:1,inputRef:'old-input.json',outputRef:old.result.evidenceRef}]}
  db.prepare("UPDATE execution_nodes SET status='ready',drained=1,drain_evidence_ref='drained.json',input_ref='new-input.json',input_digest=? WHERE node_run_id=?").run('c'.repeat(64),oldBinding.nodeRunId)
  db.prepare("UPDATE execution_runs SET status='queued' WHERE run_id='repair-run'").run()
  db.prepare("INSERT INTO execution_events(command_id,kind,payload,created_at) VALUES('formal-owner-repair','workflow.repair.accepted',?,?)").run(JSON.stringify(repair),new Date().toISOString())
  mutate(db,{old,repair,oldBinding});db.close()
  store=await openExecutionStore({dbPath,instanceId:'incremental'})
  t.after(()=>store.close())
  const binding=(await store.command({id:'next-claim',kind:'node.claim',args:{runId:'repair-run',nodeId:'apply-changes',expectedGeneration:1,expectedLeaseEpoch:1}})).result.binding
  const request={binding:{...binding,requirementDigest:'a'.repeat(64)},action:'edit',prepared:await managed.prepare({workspace:prepared.workspace,changes:[{path:'old.txt',expectedHash:hash('first'),content:'second'}]})}
  async function nextRepair(previous) {
    await store.close();const db=new DatabaseSync(dbPath)
    const audit={...repair,invalidated:[{nodeRunId:binding.nodeRunId,leaseEpoch:2,inputRef:'new-input.json',outputRef:previous.result.evidenceRef}]}
    db.prepare("UPDATE execution_nodes SET status='ready',drained=1,drain_evidence_ref='next-drained.json',input_ref='third-input.json',input_digest=? WHERE node_run_id=?").run('d'.repeat(64),binding.nodeRunId)
    db.prepare("UPDATE execution_runs SET status='queued' WHERE run_id='repair-run'").run()
    db.prepare("INSERT INTO execution_events(command_id,kind,payload,created_at) VALUES('second-formal-owner-repair','workflow.repair.accepted',?,?)").run(JSON.stringify(audit),new Date().toISOString());db.close()
    store=await openExecutionStore({dbPath,instanceId:'incremental'})
    const next=(await store.command({id:'third-claim',kind:'node.claim',args:{runId:'repair-run',nodeId:'apply-changes',expectedGeneration:1,expectedLeaseEpoch:2}})).result.binding
    return {gateway:gateway(),request:{binding:{...next,requirementDigest:'a'.repeat(64)},action:'edit',prepared:await managed.prepare({workspace:prepared.workspace,changes:[{path:'old.txt',expectedHash:hash('second'),content:'third'}]})}}
  }
  return {store,artifacts,gateway:gateway(),request,old,nextRepair,read:()=>readFile(join(directory,'old.txt'),'utf8'),count:()=>count,hash,dbPath}
}

test('同代增量编辑保留旧效果，同路径新基线只执行一次并可读审计',async t=>{
  const f=await incrementalEditFixture(t)
  const [a,b]=await Promise.all([f.gateway.execute(f.request),f.gateway.execute(f.request)])
  assert.equal(a.effectId,b.effectId);assert.notEqual(a.effectId,f.old.effectId)
  assert.equal(a.state,'succeeded');assert.equal(f.count(),2);assert.equal(await f.read(),'second')
  assert.equal((await f.gateway.execute(f.request)).effectId,a.effectId);assert.equal(f.count(),2)
  assert.equal(a.definition.editRepair.previousEffectId,f.old.effectId)
  assert.equal(a.definition.editRepair.repairCommandId,'formal-owner-repair')
  const history=await f.store.query({kind:'effect.list',runId:'repair-run'})
  assert.equal(history.length,2);assert.equal(history.find(e=>e.effectId===f.old.effectId).inputDigest,'b'.repeat(64))
  assert.equal(a.nodeRunId,f.old.nodeRunId);assert.equal(a.generation,f.old.generation)
})

for(const mode of ['missing-repair','forged-repair','unknown-effect','external-effect']) test(`增量编辑拒绝${mode}`,async t=>{
  const f=await incrementalEditFixture(t,(db,{old})=>{
    if(mode==='missing-repair')db.prepare("DELETE FROM execution_events WHERE kind='workflow.repair.accepted'").run()
    if(mode==='forged-repair')db.prepare("UPDATE execution_events SET payload=json_set(payload,'$.taskId','foreign') WHERE kind='workflow.repair.accepted'").run()
    if(mode==='unknown-effect'){db.prepare("UPDATE execution_effects SET state='unknown' WHERE effect_id=?").run(old.effectId);for(const key of old.resourceKeys)db.prepare('INSERT INTO execution_resource_holds VALUES(?,?)').run(key,old.effectId)}
    if(mode==='external-effect')db.prepare("UPDATE execution_effects SET definition_json=json_set(definition_json,'$.action','external') WHERE effect_id=?").run(old.effectId)
  })
  await assert.rejects(f.gateway.execute(f.request),{code:'EDIT_REPAIR_NOT_ADMITTED'});assert.equal(f.count(),1)
})

test('增量编辑拒绝重放原补丁与绕网关伪造新效果身份',async t=>{
  const f=await incrementalEditFixture(t)
  await assert.rejects(f.gateway.execute({...f.request,prepared:f.old.definition.payload}),{code:'EDIT_REPAIR_REPLAY_FORBIDDEN'})
  await assert.rejects(f.store.command({id:'forged-increment',kind:'effect.prepare',args:{effectId:'forged-new-edit',kind:'operation',runId:'repair-run',nodeId:'apply-changes',generation:1,leaseEpoch:2,inputDigest:f.request.binding.inputDigest,definition:{adapterId:'managed-edit',adapterVersion:'1',principalId:'host',action:'edit',payload:f.request.prepared},resourceKeys:['workspace:isolated-workspace'],authorizationRef:'original-task-requirement'}}),{code:'EDIT_REPAIR_NOT_ADMITTED'})
  assert.equal(f.count(),1)
})

test('同旧输入异内容仍由原identity guard拒绝',async t=>{
  const f=await incrementalEditFixture(t)
  await assert.rejects(f.gateway.execute({...f.request,binding:{...f.request.binding,inputDigest:f.old.inputDigest}}),{code:'DELIVERY_IDENTITY_CONFLICT'})
  assert.equal(f.count(),1)
})


test('第二次合法原地修复关联前一次增量成功效果且重投身份稳定',async t=>{
  const f=await incrementalEditFixture(t),first=await f.gateway.execute(f.request),next=await f.nextRepair(first)
  const second=await next.gateway.execute(next.request),repeated=await next.gateway.execute(next.request)
  assert.equal(second.definition.editRepair.previousEffectId,first.effectId)
  assert.notEqual(second.effectId,first.effectId);assert.equal(repeated.effectId,second.effectId)
  assert.equal(f.count(),3);assert.equal(await f.read(),'third')
})
