import { sessionWorkspace, taskDirectories, taskFilePath } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createTaskOwnerSessions } from '../packages/dingtalk-dsh-assistant/task-owner-session.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const decision = { action: 'advance', summary: '启动已登记的第一阶段', evidenceRefs: [] }

async function host(root, pageRef = null, artifactRef = null, candidate = decision, getWorkspaceDir = () => sessionWorkspace(root, 'owner')) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false,
    compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const id = `call-${requests.length}`, name = pageRef && requests.length === 1
        ? 'task_owner_read_events' : artifactRef && requests.length === 1
          ? 'task_owner_read_artifact' : 'task_owner_submit'
      const args = JSON.stringify(name === 'task_owner_read_events' ? { pageRef }
        : name === 'task_owner_read_artifact' ? { artifactRef } : { decision: typeof candidate === 'function' ? candidate(requests.length) : candidate })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['owner-fixture'], new Scripted())
  let currentLease = 1
  const sessions = createTaskOwnerSessions({ ctx, getWorkspaceDir, isCurrent: async binding => binding.leaseEpoch === currentLease })
  return { ctx, sessions, requests, setLease(value) { currentLease = value },
    async close() { await sessions.close(); await ctx.fiber.dispose() } }
}

test('同一个业务 Task 的原生 Owner 会话跨唤醒复用并持久记录候选', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root)
  t.after(() => h.close())
  const taskId = 'task-1', sessionId = 'owner-task-1', seen = []
  const run = leaseEpoch => h.sessions.run({ binding: { taskId, sessionId,
    turnId: `turn-${leaseEpoch}`, leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 },
    input: { taskId, eventWatermark: leaseEpoch, goal: { request: '整理任务交付报告' } }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => { seen.push(`bound-${leaseEpoch}`) },
    onCandidate: async value => { seen.push(`candidate-${leaseEpoch}`); assert.deepEqual(value, decision) } })
  assert.equal((await run(1)).status, 'submitted')
  h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  assert.deepEqual(seen, ['bound-1', 'candidate-1', 'bound-2', 'candidate-2'])
  const saved = await h.ctx.sessionPersistence.inspect(sessionId)
  assert.equal(saved.events.filter(event => event.type === 'dingtalk/task-owner-session').length, 1)
  assert.equal(saved.meta.cwd, join(root, 'session-workspaces', '任务负责'))
  assert.equal(saved.events.findLast(event => event.type === 'session/title').data.title, '整理任务交付报告 · 任务负责')
  assert.equal(saved.events.filter(event => event.type === 'user/message' && event.surfaceOp === 'append').length, 2)
  assert.equal(h.requests.length, 2)
  assert.ok(h.requests.every(request => request.tools.map(tool => tool.name).join(',') === 'task_owner_submit'))
  assert.match(h.requests[0].system, /先完成必要调查，再用task-general-capability阶段/u)
  assert.match(h.requests[0].system, /write-task-file/u)
  assert.match(h.requests[0].system, /含capabilityStep时，本轮planChange.stages只能有一个阶段/u)
  assert.match(h.requests[0].system, /已有计划的前序阶段必须全部成功/u)
  assert.match(h.requests[0].system, /下一轮才追加群文件交付阶段，保留各阶段的gate/u)
  assert.match(h.requests[0].system, /再安排task-group-file-delivery阶段/u)
  assert.match(h.requests[0].system, /import-task-file/u)
  assert.match(h.requests[0].system, /input严格含\{role,fileName,relativePath\}/u)
  assert.match(h.requests[0].system, /Host只读来源后冻结大小和SHA256/u)
  assert.match(h.requests[0].system, /二进制仅使用真实受信来源并已登记的artifactFiles/u)
  assert.match(h.requests[0].system, /正文报告不能替代附件/u)
})

test('原生Owner会话必须读取积压事件页后才能提交候选', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-paged-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pageRef = `sha256-${'a'.repeat(64)}.json`
  const h = await host(root, pageRef)
  t.after(() => h.close())
  const read = []
  const result = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'paged-session',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
    input: { taskId: 'task-1', eventPages: [{ ref: pageRef, firstSeq: 1, lastSeq: 1, count: 1 }] },
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    readPage: async ref => { read.push(ref); return [{ eventSeq: 1, eventType: 'task.created', payload: null }] },
    onCandidate: async value => assert.deepEqual(value, decision) })
  assert.equal(result.status, 'submitted')
  assert.deepEqual(read, [pageRef])
  assert.deepEqual(h.requests.map(request => request.tools.map(tool => tool.name)), [
    ['task_owner_read_events', 'task_owner_submit'], ['task_owner_read_events', 'task_owner_submit']])
})

test('Owner 仅能读取当前 Task 已成功阶段的产物正文', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactRef = `sha256-${'b'.repeat(64)}.json`
  const h = await host(root, null, artifactRef)
  t.after(() => h.close())
  const read = []
  const longArtifact='发现原因'.repeat(20000)+'最后条件'
  const result = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'artifact-session',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
  input: { taskId: 'task-1', stageArtifacts: [{ stageId: 'stage-1', outputRef: artifactRef,
    evidenceRefs: [] }] }, provider: 'owner-fixture', model: 'scripted',
  onSessionBound: async () => {}, readArtifact: async ref => {
    read.push(ref); return { summary: longArtifact, limitations: [] }
  }, onCandidate: async value => assert.deepEqual(value, decision) })
  assert.equal(result.status, 'submitted')
  assert.deepEqual(read, [artifactRef])
  assert.ok(JSON.stringify(h.requests).includes('最后条件'))
  assert.ok(h.requests.every(request => request.tools.some(tool => tool.name === 'task_owner_read_artifact')))
})

test('已绑定的负责人会话缺失时拒绝另建会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root)
  t.after(() => h.close())
  h.setLease(2)
  await assert.rejects(h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'missing-session',
    turnId: 'turn-2', leaseEpoch: 2, ownerEpoch: 1, sessionBound: true },
    input: { taskId: 'task-1' }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => {}, onCandidate: async () => {} }),
  { code: 'TASK_OWNER_SESSION_MISSING' })
  assert.equal(h.requests.length, 0)
})

test('会话存储读故障原样阻断，不能伪装为可重建的缺失', async () => {
  const ctx = { agents: { get: () => null }, sessions: { get: () => null },
    sessionPersistence: { inspect: async () => { throw Object.assign(new Error('disk-read-failed'), { code: 'EIO' }) } } }
  const sessions = createTaskOwnerSessions({ ctx, isCurrent: async () => true })
  await assert.rejects(sessions.run({ binding: { taskId: 'task-1', sessionId: 'session-1',
    turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: true }, input: {},
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => {} }), { code: 'EIO' })
  await sessions.close()
})


test('Owner新增能力阶段只接纳已登记写能力，调查读取不能逐次编排', async t => {
  for (const effectClass of ['read', 'file.write']) {
    const root = await mkdtemp(join(tmpdir(), 'task-owner-capability-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const candidate = { ...decision, planChange: { kind: 'initialize', stages: [{ workflowId: 'task-general-capability', gate: 'none', capabilityStep: { capabilityId: 'cap', input: {}, expectedEvidence: 'artifact' } }] } }
    const h = await host(root, null, null, candidate); t.after(() => h.close())
    let accepted = 0
    const outcome = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'owner-capability', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { taskId: 'task-1', capabilities: [{ id: 'cap', effectClass }] }, provider: 'owner-fixture', model: 'scripted',
      onSessionBound: async () => {}, onCandidate: async () => { accepted++ } })
    assert.equal(outcome.status, effectClass === 'read' ? 'no_submission' : 'submitted')
    assert.equal(accepted, effectClass === 'read' ? 0 : 1)
  }
})


test('原生Owner公开摘要含内部编号时工具反馈要求改写，记录仍保留绑定', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-public-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root, null, null, turn => ({ ...decision, summary: turn === 1 ? '任务会话已启动；taskId=task-1' : '已开始整理资料。' }))
  t.after(() => h.close())
  const candidates = []
  const result = await h.sessions.run({ binding: { taskId: 'task-1', sessionId: 'public-session', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false }, input: { taskId: 'task-1' }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {}, onCandidate: async value => candidates.push(value) })
  assert.equal(result.status, 'submitted')
  assert.equal(h.requests.length, 2)
  assert.deepEqual(candidates.map(value => value.summary), ['已开始整理资料。'])
  assert.match(h.requests[0].system, /发给群成员的回复/u)
  assert.match(JSON.stringify(h.requests[1]), /GROUP_REPLY_INTERNAL_DETAILS/u)
  assert.ok((await h.ctx.sessionPersistence.inspect('public-session')).events.length > 0)
})


test('Owner原生工作目录使用受信任务绑定，重启保持cwd及宿主日志根', async t => {
  const base = resolve('docs/tmp/task-owner-session-native')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'run-')), selected = []
  const h = await host(root, null, null, decision, async ({ binding }) => {
    selected.push(structuredClone(binding))
    return (await taskDirectories(root, binding.taskId)).work
  })
  t.after(() => h.close())
  const run = (host, taskId, leaseEpoch = 1) => host.sessions.run({
    binding: { taskId, sessionId: `owner-${taskId}`, turnId: `turn-${leaseEpoch}`, leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 },
    input: { taskId: 'forged', cwd: root }, provider: 'owner-fixture', model: 'scripted',
    onSessionBound: async () => {}, onCandidate: async () => {} })
  const locations = []
  for (const taskId of ['task-a', 'task-b']) {
    assert.equal((await run(h, taskId)).status, 'submitted')
    const saved = await h.ctx.sessionPersistence.inspect(`owner-${taskId}`)
    assert.equal(saved.meta.cwd, taskFilePath(root, taskId, 'work'))
    const location = h.ctx.sessionPersistence.locate(saved.meta).path
    assert.ok(location.startsWith(join(root, 'sessions') + sep))
    assert.ok(!location.startsWith(join(root, 'tasks') + sep))
    assert.match(await readFile(location, 'utf8'), /dingtalk\/task-owner-session/)
    locations.push(location)
  }
  assert.deepEqual(selected.map(binding => binding.taskId), ['task-a', 'task-b'])
  assert.deepEqual(selected.map(binding => binding.sessionId), ['owner-task-a', 'owner-task-b'])
  assert.notEqual(locations[0], locations[1])
  await h.close()
  const resumed = await host(root, null, null, decision, () => { throw new Error('must not reselect persisted cwd') })
  t.after(() => resumed.close()); resumed.setLease(2)
  assert.equal((await run(resumed, 'task-a', 2)).status, 'submitted')
  const saved = await resumed.ctx.sessionPersistence.inspect('owner-task-a')
  assert.equal(saved.meta.cwd, taskFilePath(root, 'task-a', 'work'))
  assert.equal(resumed.ctx.sessionPersistence.locate(saved.meta).path, locations[0])
  assert.equal(saved.events.filter(event => event.type === 'user/message' && event.surfaceOp === 'append').length, 2)
})

test('Owner原生会话引用拒绝可修正，未知持久化错误仍终止', async t => {
  for (const code of ['TASK_OWNER_REF_INVALID', 'TASK_OWNER_STORAGE_UNKNOWN']) {
    const root = await mkdtemp(join(tmpdir(), 'task-owner-correction-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const h = await host(root, null, null, step => ({ ...decision, evidenceRefs: step === 1 ? ['dws:source'] : [] }))
    t.after(() => h.close())
    let calls = 0
    const result = await h.sessions.run({ binding: { taskId: 'task-correction', sessionId: 'owner-correction', turnId: 'turn-1', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { goal: { request: '调查' } }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      onCandidate: async value => { calls++; if (value.evidenceRefs.length) throw Object.assign(Error(code), { code }) } })
    assert.equal(result.status, code === 'TASK_OWNER_REF_INVALID' ? 'submitted' : 'no_submission')
    assert.equal(calls, code === 'TASK_OWNER_REF_INVALID' ? 2 : 1)
    if (calls === 2) assert.match(JSON.stringify(h.requests[1]), /TASK_OWNER_REF_INVALID/u)
  }
})

test('Owner完整大材料重试只保留当前输入投影，原始快照审计不改写', async t => {
  const root = await mkdtemp(join(tmpdir(), 'task-owner-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const marker = 'WORKBOOK_FULL_BODY_4eb39'
  const body = marker + '完整单元格正文'.repeat(70000)
  let reject = true
  const run = leaseEpoch => h.sessions.run({ binding: { taskId: 'task-snapshot', sessionId: 'owner-snapshot', turnId: `turn-${leaseEpoch}`,
    leaseEpoch, ownerEpoch: 1, sessionBound: leaseEpoch > 1 }, input: { taskId: 'task-snapshot', goal: { materials: [{ text: body }] } },
    provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
    onCandidate: async () => { if (reject) throw Object.assign(Error('UNKNOWN_STORAGE'), { code: 'UNKNOWN_STORAGE' }) } })
  assert.equal((await run(1)).status, 'no_submission')
  const first = await h.ctx.sessionPersistence.inspect('owner-snapshot')
  reject = false; h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  const request = JSON.stringify(h.requests[1])
  assert.equal(request.split(marker).length - 1, 1)
  assert.ok(request.includes(body))
  assert.match(request, /superseded/u)
  const after = await h.ctx.sessionPersistence.inspect('owner-snapshot')
  assert.deepEqual(after.events.slice(0, first.events.length), first.events)
  assert.equal(after.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
  assert.equal(after.events.filter(e => e.surfaceOp?.op === 'replace').length, 1)
})

test('Owner引用纠正不能越过旧lease且连续错误仍受步骤预算约束', async t => {
  for (const stale of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'task-owner-ref-fence-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const h = await host(root); t.after(() => h.close())
    let calls = 0
    const result = await h.sessions.run({ binding: { taskId: 'task-ref', sessionId: 'owner-ref', turnId: 'turn-ref', leaseEpoch: 1, ownerEpoch: 1, sessionBound: false },
      input: { goal: { request: '调查' } }, provider: 'owner-fixture', model: 'scripted', onSessionBound: async () => {},
      onCandidate: async () => { calls++; if (stale) h.setLease(2); throw Object.assign(Error('bad ref'), { code: 'TASK_OWNER_REF_INVALID' }) } })
    assert.equal(result.status, stale ? 'stale' : 'no_submission')
    assert.equal(calls, stale ? 1 : 8)
  }
})

test('Owner原生修复仅接受当前绑定，错误动作可在同轮纠正',async t=>{
 for(const mode of ['absent','stale','valid']){
  const root=await mkdtemp(join(tmpdir(),'owner-repair-binding-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const repair={stageId:'stage-1',runId:'run-1',generation:1,runRevision:0,requirementRevision:2}
  const h=await host(root,null,null,step=>step===1?{action:'repairCurrentStage',repair:{...repair,runRevision:mode==='stale'?1:0},summary:'重查',evidenceRefs:[]}:decision)
  t.after(()=>h.close());const submitted=[]
  const result=await h.sessions.run({binding:{taskId:'task-repair',sessionId:'owner-repair',turnId:'turn-1',leaseEpoch:1,ownerEpoch:1,sessionBound:false},
   input:{goal:{request:'调查'},currentExecution:mode==='absent'?null:{repairable:true,repairBinding:repair}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>submitted.push(value)})
  assert.equal(result.status,'submitted');assert.equal(submitted.length,1)
  assert.equal(submitted[0].action,mode==='valid'?'repairCurrentStage':decision.action)
  assert.equal(h.requests.length,mode==='valid'?1:2)
 }
})

test('Owner初始计划错误在同一原生turn内修正为initialize',async t=>{
 const root=await mkdtemp(join(tmpdir(),'owner-plan-correction-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const h=await host(root,null,null,step=>({action:'advance',summary:'先调查',evidenceRefs:[],planChange:step===1?{kind:'replaceSuffix',affectedFrom:0,stages:[{workflowId:'task-investigation',gate:'none'}]}:{kind:'initialize',stages:[{workflowId:'task-investigation',gate:'none'}]}}));t.after(()=>h.close())
 let calls=0
 const result=await h.sessions.run({binding:{taskId:'new-task',sessionId:'new-owner',turnId:'turn-1',leaseEpoch:1,ownerEpoch:1,sessionBound:false},input:{task:{planRevision:0},stages:[],goal:{request:'调查'}},provider:'owner-fixture',model:'scripted',onSessionBound:async()=>{},onCandidate:async value=>{calls++;if(value.planChange.kind!=='initialize')throw Object.assign(Error('TASK_OWNER_ADVANCE_CONFLICT'),{code:'TASK_OWNER_ADVANCE_CONFLICT'})}})
 assert.equal(result.status,'submitted');assert.equal(calls,2);assert.equal(result.decision.planChange.kind,'initialize');assert.match(JSON.stringify(h.requests[1]),/尚无计划/)
})
