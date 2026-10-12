import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { defineExecutionWorkflow, createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'

async function fixture(t, { grant, execute, reconcile, authorizeExternal, authorizationNode = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-external-delivery-'))
  const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'external-test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  t.after(() => store.close())
  await store.command({ id: 'create', kind: 'run.create', args: {
    runId: 'run', taskId: 'task', workflowId: 'release', workflowDigest: 'a'.repeat(64), requirementRef: 'requirement',
    nodes: [{ nodeId: 'release', nodeVersion: '1', executor: 'code', inputRef: 'input', inputDigest: 'b'.repeat(64) }],
  } })
  const { result: { binding } } = await store.command({ id: 'claim', kind: 'node.claim', args: {
    runId: 'run', nodeId: 'release', expectedGeneration: 1, expectedLeaseEpoch: 0,
  } })
  let sends = 0
  const adapter = {
    execute: async prepared => { sends++; return execute ? execute(prepared) : { status: 'succeeded', evidenceRef: 'external-task-1' } },
    reconcile: reconcile ?? (async () => ({ status: 'succeeded', evidenceRef: 'external-task-1' })),
  }
  const gateway = createExecutionDelivery({ store, artifacts, authorize: async () => ({ principalId: 'owner', authorizationRef: 'old-git-only' }),
    externalAdapter: adapter, authorizeExternal: authorizeExternal ?? (async () => grant ?? { principalId: 'owner', approval: { requestId: 'approval-1', approverIds: ['owner'] } }),
  })
  const request = { binding: { ...binding, taskId: 'task', requirementDigest: 'c'.repeat(64) }, action: 'external', prepared: {
    action: 'external', workflowKind: 'production-release', runId: 'run', generation: 1, requirementDigest: 'c'.repeat(64),
    resourceKey: 'external:production:service-a', targetCommit: 'd'.repeat(40),
  } }
  const rawGateway = gateway
  return { dbPath: join(root, 'control.db'), artifacts, store, rawGateway, gateway: { ...gateway, execute: (request, context = {}) => rawGateway.execute(request, { ...context, authorizationNode, authorizationRequested: authorizationNode }) }, request, sends: () => sends }
}

test('外部效果只能给受信 code 节点，审批前零发送，Web 首次终态后只发送一次', async t => {
  const node = { id: 'release', version: '1', executor: 'code', allowedEffects: ['external.operation'],
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => ({}) }
  assert.doesNotThrow(() => defineExecutionWorkflow({ id: 'release', version: '1', nodes: [node] }))
  assert.throws(() => defineExecutionWorkflow({ id: 'release', version: '1', nodes: [{ ...node, executor: 'agent' }] }), { code: 'EFFECT_NOT_ADMITTED' })
  const f = await fixture(t)
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_approval_required' })
  assert.equal(f.sends(), 0)
  const effect = (await f.store.query({ kind: 'effect.list', runId: 'run' }))[0]
  assert.equal(effect.state, 'prepared')
  assert.equal(effect.requestId, 'approval-1')
  await f.store.command({ id: 'approve', kind: 'approval.decide', args: { requestId: 'approval-1', actorId: 'owner', source: 'web', decision: 'approved' } })
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.equal(f.sends(), 1)
})

test('外部效果身份变化与撤权阻止发送', async t => {
  const f = await fixture(t, { grant: { principalId: 'owner', authorizationRef: 'exact-target-grant' } })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, runId: 'other' } }), { code: 'DELIVERY_INPUT_INVALID' })
  await assert.rejects(f.gateway.execute({ ...f.request, prepared: { ...f.request.prepared, resourceKey: 'workspace:unscoped' } }), { code: 'DELIVERY_INPUT_INVALID' })
  await f.store.command({ id: 'revoke', kind: 'safety.revoke', args: { scope: 'resource', key: f.request.prepared.resourceKey, reason: 'test' } })
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_safety_revoked' })
  assert.equal(f.sends(), 0)
})

test('外部回执未知时只回读，不二次执行', async t => {
  const f = await fixture(t, { grant: { principalId: 'owner', authorizationRef: 'exact-target-grant' },
    execute: async () => { throw new Error('lost ack') }, reconcile: async () => ({ status: 'succeeded', evidenceRef: 'readback-1' }) })
  assert.equal((await f.gateway.execute(f.request)).state, 'unknown')
  assert.equal((await f.gateway.execute(f.request)).state, 'succeeded')
  assert.equal(f.sends(), 1)
})


test('revoked direct UAT grant is rechecked before dispatch; restoring exact grant preserves one effect', async t => {
  const grant = { principalId: 'owner', authorizationRef: 'uat-build:exact-current-source' }
  let calls = 0, restored = false
  const f = await fixture(t, { authorizeExternal: async () => (++calls === 1 || restored) ? grant : null })
  f.request.prepared.workflowKind = 'uat-deployment'
  f.request.prepared.operation = 'build'
  await assert.rejects(f.gateway.execute(f.request), { code: 'DELIVERY_AUTHORIZATION_STALE' })
  assert.equal(f.sends(), 0)
  let effects = await f.store.query({ kind: 'effect.list', runId: 'run' })
  assert.equal(effects.length, 1); assert.equal(effects[0].state, 'prepared')
  restored = true
  await f.gateway.execute(f.request)
  await f.gateway.execute(f.request)
  assert.equal(f.sends(), 1)
  effects = await f.store.query({ kind: 'effect.list', runId: 'run' })
  assert.equal(effects.length, 1); assert.equal(effects[0].authorizationRef, grant.authorizationRef)
})


test('ordinary node routes missing business authorization to execution-session assessment and creates no request', async t => {
 const f = await fixture(t, { authorizationNode: false })
 await assert.rejects(f.gateway.execute(f.request), { code: 'AUTHORIZATION_ASSESSMENT_REQUIRED' })
 assert.equal(f.sends(), 0)
 assert.deepEqual(await f.store.query({ kind: 'effect.list', runId: 'run' }), [])
})
test('code nodes cannot declare a business-authorization session', () => {
 const node={id:'authorize',version:'1',executor:'code',authorizationNode:true,allowedEffects:['external.operation'],inputSchema:{},outputSchema:{},mapInput:({requirement})=>requirement,execute:async()=>({})}
 assert.throws(()=>defineExecutionWorkflow({id:'release',version:'1',nodes:[node]}),{code:'AUTHORIZATION_NODE_INVALID'})
})

for (const [authorizationNode, request] of [[false,false],[true,true],[true,false]]) test('native controller requires session-initiated authorization: '+authorizationNode+'/'+request, async t => {
 const dir = await mkdtemp(join(tmpdir(), 'dsh-explicit-authorization-'))
 const store = await openExecutionStore({ dbPath: join(dir, 'control.db'), instanceId: 'auth-node', initialize: true })
 const artifacts = await openExecutionArtifacts({ directory: join(dir, 'artifacts'), initialize: true })
 let sends = 0
 const delivery = createExecutionDelivery({ store, artifacts, authorize: async () => null,
   authorizeExternal: async () => ({ principalId: 'owner', approval: { requestId: 'visible-request', approverIds: ['owner'] } }),
   externalAdapter: { execute: async () => { sends++; return { status: 'succeeded', evidenceRef: 'sent' } }, reconcile: async () => ({ status: 'unseen' }) } })
 const workflow = { id: 'explicit-authorization-flow', version: '1', nodes: [{ id: authorizationNode ? 'authorization' : 'execute', version: '1', executor: authorizationNode ? 'agent' : 'code', ...(authorizationNode ? { authorizationNode: true, authorizationExecute: async ({runId,generation,requirementDigest,perform})=>perform({action:'external',prepared:{action:'external',workflowKind:'production-release',operation:'approval-gate',runId,generation,requirementDigest,resourceKey:'external:production:fixture'}}), provider:'fixture',model:'fixture',prompt:'Assess and explicitly request authorization',allowedTools:['execution_request_authorization'] } : {}), allowedEffects: ['external.operation'], inputSchema: {}, outputSchema: {}, mapInput: ({ requirement }) => requirement,
   execute: async ({ runId, generation, requirementDigest, perform }) => perform({ action: 'external', prepared: { action: 'external', workflowKind: 'production-release', operation: 'approval-gate', runId, generation, requirementDigest, resourceKey: 'external:production:fixture' } }) }] }
 const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow], sessions: { close: async()=>{}, run: async ({requestAuthorization,onResult})=>{ if(request) await requestAuthorization('Actual action needs business approval',new AbortController().signal); else await onResult({approved:true}); return {status:'completed',drained:true} } } })
 t.after(async () => { await controller.close(); await store.close() })
 await controller.createRun({ commandId: 'auth-create', runId: 'auth-run', taskId: 'auth-task', workflowId: workflow.id, input: {} })
 const state = await controller.whenIdle('auth-run')
 assert.equal(state.run.status, 'waiting'); assert.equal(sends, 0)
 const effects = await store.query({ kind: 'effect.list', runId: 'auth-run' })
 assert.equal(effects.length, authorizationNode && request ? 1 : 0)
 if (authorizationNode && request) assert.equal(effects[0].requestId, 'visible-request')
 else if(!authorizationNode) assert.ok(JSON.stringify(state).includes('AUTHORIZATION_ASSESSMENT_REQUIRED'))
})

 test('authorization failures belong to executor assessment and real authorization waiting', async () => {
 const { classifyExecutionFailure } = await import('../packages/dingtalk-dsh-assistant/execution-recovery-policy.js')
 assert.deepEqual(classifyExecutionFailure({code:'AUTHORIZATION_ASSESSMENT_REQUIRED'}),{category:'authorization-assessment',responsibleParty:'node-executor',nextAction:'assess-authorization-and-use-visible-step'})
 assert.deepEqual(classifyExecutionFailure({code:'effect_approval_required'}),{category:'authorization-waiting',responsibleParty:'authorization-session',nextAction:'await-real-authorization-result'})
 })


for (const decision of ['pending', 'rejected', 'revoked']) test(`legacy ordinary prepared effect rejects ${decision} original approval without dispatch`, async t => {
  const f = await fixture(t)
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_approval_required' })
  const original = (await f.store.query({ kind: 'effect.list', runId: 'run' }))[0]
  if (decision !== 'pending') await f.store.command({ id: 'decide-legacy', kind: 'approval.decide', args: { requestId: original.requestId, actorId: 'owner', source: 'web', decision: decision === 'revoked' ? 'approved' : decision } })
  if (decision === 'revoked') await f.store.command({ id: 'revoke-legacy', kind: 'approval.revoke', args: { requestId: original.requestId, actorId: 'owner', source: 'web' } })
  await assert.rejects(f.rawGateway.execute(f.request), { code: 'AUTHORIZATION_ASSESSMENT_REQUIRED' })
  assert.equal(f.sends(), 0)
  assert.deepEqual(await f.store.query({ kind: 'effect.get', effectId: original.effectId }), original)
})

test('legacy approved ordinary effect resumes the same effect after Store close/reopen with one dispatch and no new approval', async t => {
  const f = await fixture(t)
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_approval_required' })
  const original = (await f.store.query({ kind: 'effect.list', runId: 'run' }))[0]
  await f.store.command({ id: 'approve-legacy', kind: 'approval.decide', args: { requestId: original.requestId, actorId: 'owner', source: 'web', decision: 'approved' } })
  const identity = { runId: 'run', nodeId: 'release', generation: 1, leaseEpoch: f.request.binding.leaseEpoch }
  await f.store.command({ id: 'legacy-drained', kind: 'node.drained', args: { ...identity, evidenceRef: 'fixture/no-operation-started' } })
  await f.store.command({ id: 'legacy-waiting', kind: 'node.commit', args: { ...identity, inputDigest: f.request.binding.inputDigest, outcome: 'waiting', evidenceRefs: [], waitReason: { kind: 'recovery', reference: 'AUTHORIZATION_ASSESSMENT_REQUIRED' } } })
  await f.store.close()
  const store = await openExecutionStore({ dbPath: f.dbPath, instanceId: 'external-test' })
  t.after(() => store.close())
  let sends = 0
  const gateway = createExecutionDelivery({ store, artifacts: f.artifacts, authorize: async () => null, authorizeExternal: async () => { throw Error('NEW_APPROVAL_FORBIDDEN') },
    externalAdapter: { execute: async () => { sends++; return { status: 'succeeded', evidenceRef: 'legacy-sent' } }, reconcile: async () => ({ status: 'succeeded', evidenceRef: 'legacy-sent' }) } })
  const effectsBefore = await store.query({ kind: 'effect.list', runId: 'run' })
  assert.equal(effectsBefore.length, 1); assert.equal(effectsBefore[0].effectId, original.effectId)
  await store.command({ id: 'legacy-recover', kind: 'run.recover', args: { runId: 'run' } })
  const claim = await store.command({ id: 'legacy-reclaim', kind: 'node.claim', args: { runId: 'run', nodeId: 'release', expectedGeneration: 1, expectedLeaseEpoch: f.request.binding.leaseEpoch } })
  f.request.binding = { ...claim.result.binding, taskId: 'task', requirementDigest: f.request.binding.requirementDigest }
  const result = await gateway.execute(f.request)
  assert.equal(result.effectId, original.effectId); assert.equal(result.state, 'succeeded')
  assert.equal((await gateway.execute(f.request)).effectId, original.effectId)
  assert.equal(sends, 1); assert.equal((await store.query({ kind: 'effect.list', runId: 'run' })).length, 1)
  assert.equal((await store.query({ kind: 'approval.get', requestId: original.requestId })).decision, 'approved')
})

for (const payloadHasTaskId of [false, true]) test(`legacy approved ordinary effect rejects wrong task, run, target and approval binding; payload taskId=${payloadHasTaskId}`, async t => {
  const f = await fixture(t); if (payloadHasTaskId) f.request.prepared.taskId = 'task'
  await assert.rejects(f.gateway.execute(f.request), { code: 'effect_approval_required' })
  const original = (await f.store.query({ kind: 'effect.list', runId: 'run' }))[0]
  await f.store.command({ id: 'approve-identity', kind: 'approval.decide', args: { requestId: original.requestId, actorId: 'owner', source: 'web', decision: 'approved' } })
  for (const change of [
    request => { request.binding.taskId = 'other-task' },
    request => { request.binding.runId = 'other-run'; request.prepared.runId = 'other-run' },
    request => { request.prepared.targetCommit = 'e'.repeat(40) },
  ]) { const request = structuredClone(f.request); change(request); await assert.rejects(f.rawGateway.execute(request), { code: 'DELIVERY_IDENTITY_CONFLICT' }) }
  const store = { query: async query => { const result = await f.store.query(query); return query.kind === 'approval.get' ? { ...result, effectId: 'other-effect' } : result }, command: (...args) => f.store.command(...args) }
  const gateway = createExecutionDelivery({ store, artifacts: f.artifacts, authorize: async () => null, externalAdapter: { execute: async () => { throw Error('UNEXPECTED_DISPATCH') }, reconcile: async () => ({ status: 'unknown' }) } })
  await assert.rejects(gateway.execute(f.request), { code: 'DELIVERY_IDENTITY_CONFLICT' })
  assert.equal(f.sends(), 0); assert.deepEqual(await f.store.query({ kind: 'effect.get', effectId: original.effectId }), original)
})
