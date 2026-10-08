import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { createGroupCoordinatorSessions } from '../packages/dingtalk-dsh-assistant/group-coordinator-session.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')
const decision = { kind: 'no_action', reason: '人际闲聊' }
const decisionSchema = { type: 'object', properties: { kind: { type: 'string' }, reason: { type: 'string' } }, required: ['kind', 'reason'], additionalProperties: false }
async function host(root, options = {}) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  new ApprovalService(ctx, { policy: 'ask' })
  new PermissionPresetService(ctx, { presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  const memberships = new Map()
  ctx.provide('workspaceRegistry', {
    async resolveByPath(path) { return memberships.get(path) },
    async create(path) {
      const target = { sessionIds: [], async attachSession(id) {
        assert.equal((await ctx.sessionPersistence.inspect(id)).meta.cwd, path)
        if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
      } }
      memberships.set(path, target); return target
    },
  })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = []
  const optionsForHost = options
  class Scripted extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const failure=optionsForHost.providerFailure?.(requests.length)
      if(failure){yield {type:'finish',reason:{kind:'error',failure}};return}
      if (optionsForHost.noSubmission) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      const id = `call-${requests.length}`, name = requests.length === 1 ? 'read_material' : 'group_coordinator_submit'
      const args = JSON.stringify(name === 'read_material' ? { ref: 'file' } : { decision })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['group-fixture'], new Scripted())
  let lease = 1
  const sessions = createGroupCoordinatorSessions({ ctx, isCurrent: async b => b.leaseEpoch === lease, ...options })
  return { ctx, requests, sessions, memberships, setLease(n) { lease = n }, async close() { await sessions.close(); await ctx.fiber.dispose() } }
}

test('原生群会话同轮读取材料后提交，跨轮恢复同一session并保留历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-native-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let reads = 0, candidates = 0
  const terminalResults = []
  h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'group_coordinator_submit') terminalResults.push(result.concludesTurn === true) })
  const run = leaseEpoch => h.sessions.run({ binding: { conversationId: 'group', sessionId: 'group-session', turnId: `turn-${leaseEpoch}`, leaseEpoch, sessionBound: leaseEpoch > 1 },
    input: { messages: [{ actorId: 'user', text: '核对材料后按已有任务推进' }] }, provider: 'group-fixture', model: 'scripted', decisionSchema,
    onSessionBound: async () => {}, onCandidate: async value => { candidates++; assert.deepEqual(value, decision) },
    readTools: [{ name: 'read_material', effectClass: 'read', description: '读取授权材料', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a, v) => [{ type: 'text', text: v.text }] },
      execute: async ({ ref }) => { assert.equal(ref, 'file'); reads++; return { text: '真实材料内容' } } }] })
  assert.equal((await run(1)).status, 'submitted')
  h.setLease(2)
  assert.equal((await run(2)).status, 'submitted')
  assert.equal(reads, 1); assert.equal(candidates, 2)
  assert.deepEqual(terminalResults, [true, true])
  const persisted = await h.ctx.sessionPersistence.inspect('group-session')
  assert.equal(persisted.events.filter(e => e.type === 'dingtalk/group-coordinator-session').length, 1)
  assert.equal(persisted.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
  assert.equal(h.requests.length, 3)
  await assert.rejects(run(2), /LEASE_NOT_ADVANCED/)
})

test('原生群会话候选任务版本过期可反馈并重新提交，不新建会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const readTools = [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }]
  const result = await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'g-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools,
    onSessionBound: async () => {}, onCandidate: async () => { if (++submissions === 1) throw Object.assign(Error('TASK_VERSION_STALE'), { code: 'TASK_VERSION_STALE' }) } })
  assert.equal(result.status, 'submitted'); assert.equal(submissions, 2)
  assert.equal(h.requests.length, 3)
})


test('群逻辑会话跨原生宿主重启恢复，禁止注入写工具', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tool = { name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }
  const args = { binding: { conversationId: 'g', sessionId: 'restart-session', turnId: 'first', leaseEpoch: 1, sessionBound: false }, input: { message: '先审查' }, provider: 'group-fixture', model: 'scripted', decisionSchema,
    readTools: [tool], onSessionBound: async () => {}, onCandidate: async () => {} }
  const first = await host(root)
  assert.equal((await first.sessions.run(args)).status, 'submitted')
  await first.close()
  const second = await host(root); t.after(() => second.close()); second.setLease(2)
  const next = { ...args, binding: { ...args.binding, turnId: 'second', leaseEpoch: 2, sessionBound: true }, input: { message: '原需求补充' } }
  await assert.rejects(second.sessions.run({ ...next, readTools: [{ ...tool, effectClass: 'write' }] }), /READ_TOOL_REQUIRED/)
  assert.equal((await second.sessions.run(next)).status, 'submitted')
  const saved = await second.ctx.sessionPersistence.inspect('restart-session')
  assert.equal(saved.events.filter(e => e.type === 'dingtalk/group-coordinator-session').length, 1)
  assert.equal(saved.events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2)
})


for (const stop of ['cancel', 'close']) test(`同群会话互斥，${stop}等待原生工具排空后释放会话`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const started = Promise.withResolvers()
  const args = { binding: { conversationId: 'g', sessionId: 'cancel-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema,
    onSessionBound: async () => {}, onCandidate: async () => { throw Error('不得提交') },
    readTools: [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] }, execute: async (_args, exec) => {
        started.resolve()
        await new Promise((resolve, reject) => { if (exec.signal.aborted) reject(exec.signal.reason); else exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true }) })
        return {}
      } }] }
  const running = h.sessions.run(args)
  await started.promise
  await assert.rejects(h.sessions.run(args), /GROUP_COORDINATOR_BUSY/)
  if (stop === 'close') await h.sessions.close()
  else await h.sessions.cancel('g')
  assert.equal((await running).status, 'cancelled')
  assert.equal(h.ctx.agents.get('cancel-session'), undefined)
})

test('来源版本过期结束旧claim，不在旧来源上反复提交', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const readTools = [{ name: 'read_material', effectClass: 'read', description: '读取', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a,v) => [{ type: 'text', text: v.text }] }, execute: async () => ({ text: '材料' }) }]
  const result = await h.sessions.run({ binding: { conversationId: 'g', sessionId: 'g-session', turnId: 't', leaseEpoch: 1, sessionBound: false }, input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, readTools,
    onSessionBound: async () => {}, onCandidate: async () => { submissions++; throw Object.assign(Error('MESSAGE_STALE'), { code: 'MESSAGE_STALE' }) } })
  assert.equal(result.status, 'stale'); assert.equal(result.reason, 'MESSAGE_STALE'); assert.equal(submissions, 1)
  assert.equal(h.requests.length, 2)
})


test('原生会话超过32次合法反馈仍可继续提交，不设自造步数上限', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-unbounded-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  let submissions = 0
  const result = await h.sessions.run({ binding: { conversationId: 'group', sessionId: 'unbounded', turnId: 'turn', leaseEpoch: 1, sessionBound: false },
    input: {}, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {},
    onCandidate: async () => { if (++submissions <= 33) throw Object.assign(new Error('合并重复动作'), { code: 'GROUP_COORDINATOR_EXISTING_TASK_REQUIRES_UPDATE' }) } })
  assert.equal(result.status, 'submitted'); assert.equal(submissions, 34)
})

test('旧职责目录派生到Agent根，完整继承日志，恢复群名和完全权限且不调用模型', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-relocation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let cwd = join(root, 'session-workspaces', '群聊常驻'), name = '具有超过二十八字的完整群聊名称用于验证名称没有被事项标题截断'
  await mkdir(cwd, { recursive: true })
  const h = await host(root, { getWorkspaceDir: () => cwd, getGroupName: () => name }); t.after(() => h.close())
  const args = { binding: { conversationId: 'group', sessionId: 'old-group', turnId: 'first', leaseEpoch: 1, sessionBound: false },
    input: { sources: [{ runId: 'm1', sourceVersion: 1, actorId: 'user', sourceKey: 'source:m1', body: '不要改生产，只分析；附件已提供', context: { quotes: [{ text: '引用原文' }], attachments: [{ resourceRef: 'file' }] } }], candidates: [{ obsoleteSnapshot: '旧目录'.repeat(20000) }] },
    provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} }
  assert.equal((await h.sessions.run(args)).status, 'submitted')
  const parent = await h.ctx.sessionPersistence.inspect('old-group')
  const parentPath = h.ctx.sessionPersistence.locate(parent.meta).path, originalBytes = await readFile(parentPath)
  assert.equal(parent.events.findLast(e => e.type === 'session/title').data.title, name)
  assert.equal(parent.events.findLast(e => e.type === 'permission/preset').data.preset, 'danger-full-access')
  assert.equal(parent.events.findLast(e => e.type === 'approval/policy').data.policy, 'never')
  cwd = root
  const binding = { conversationId: 'group', sessionId: 'old-group', sessionBound: true, leaseEpoch: 1 }
  const callsBefore = h.requests.length
  const relocated = await h.sessions.prepare(binding)
  assert.equal(relocated.previousSessionId, 'old-group')
  assert.equal(relocated.expectedLeaseEpoch, 1)
  assert.equal(h.requests.length, callsBefore)
  // 模拟绑定CAS回执丢失：同一旧绑定只恢复同一个派生Session，不重复复制。
  assert.deepEqual(await h.sessions.prepare(binding), relocated)
  const child = await h.ctx.sessionPersistence.inspect(relocated.sessionId)
  assert.equal(child.meta.cwd, root)
  assert.deepEqual(h.memberships.get(root).sessionIds, [relocated.sessionId])
  assert.ok(h.ctx.sessions.get(relocated.sessionId), '空闲协调会话仍挂接，宿主可读标题与权限投影')
  const visible = h.ctx.sessionProjections.cachedSnapshot(h.ctx.sessions.get(relocated.sessionId))
  assert.equal(visible.values.title, name)
  assert.equal(visible.values.permissions.currentValue, 'danger-full-access')
  assert.equal(child.meta.parentSession, 'old-group')
  assert.equal(child.inheritedEventCount, parent.events.length)
  assert.deepEqual(child.events.slice(0, parent.events.length), parent.events)
  assert.deepEqual(await readFile(parentPath), originalBytes)
  const history = child.events.findLast(e => e.data?.source?.groupCoordinatorHistory)
  assert.equal(JSON.parse(history.data.content[0].text).sources[0].body, args.input.sources[0].body)
  assert.deepEqual(JSON.parse(history.data.content[0].text).sources[0].attachments, args.input.sources[0].context.attachments)
  assert.ok(!history.data.content[0].text.includes('obsoleteSnapshot'))
  h.setLease(3); name = '广场与编辑器迭代'
  assert.equal(await h.sessions.prepare({ conversationId: 'group', sessionId: relocated.sessionId, sessionBound: true, leaseEpoch: 2 }), null)
  assert.equal(h.requests.length, callsBefore)
  assert.equal((await h.ctx.sessionPersistence.inspect(relocated.sessionId)).events.findLast(e => e.type === 'session/title').data.title, name)
  assert.equal((await h.sessions.run({ ...args, input: { sources: [], candidates: [{ current: true }] },
    binding: { ...args.binding, sessionId: relocated.sessionId, turnId: 'next', leaseEpoch: 3, sessionBound: true } })).status, 'submitted')
  const saved = await h.ctx.sessionPersistence.inspect(relocated.sessionId)
  assert.equal(saved.events.findLast(e => e.type === 'session/title').data.title, name)
  assert.equal(saved.events.filter(e => e.type === 'dingtalk/group-coordinator-session').length, 2)
  await assert.rejects(h.sessions.run({ ...args, binding: { ...args.binding, sessionId: relocated.sessionId, leaseEpoch: 3, sessionBound: true } }), /LEASE_NOT_ADVANCED/)
})

test('每轮完整输入保留，下一轮原生surface只保留历史来源而不重复Host快照', async t => {
  const root = await mkdtemp(join(tmpdir(), 'group-input-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await host(root); t.after(() => h.close())
  const input = { sources: [{ runId: 'm1', sourceVersion: 1, actorId: 'user', sourceKey: 'source:m1', body: '完整原文：仅分析、不执行' }], candidates: [{ fullHostSnapshot: '旧候选'.repeat(10000) }] }
  const args = { binding: { conversationId: 'group', sessionId: 'history-group', turnId: 'first', leaseEpoch: 1, sessionBound: false },
    input, provider: 'group-fixture', model: 'scripted', decisionSchema, onSessionBound: async () => {}, onCandidate: async () => {} }
  await h.sessions.run(args)
  const before = JSON.stringify(h.requests[0].messages)
  assert.ok(before.includes('fullHostSnapshot'))
  h.setLease(2)
  await h.sessions.run({ ...args, input: { sources: [{ ...input.sources[0], runId: 'm2', body: '补充事实' }], candidates: [{ currentSnapshot: '本轮完整目录' }] },
    binding: { ...args.binding, turnId: 'next', leaseEpoch: 2, sessionBound: true } })
  const current = JSON.stringify(h.requests.at(-1).messages)
  assert.ok(current.includes('完整原文：仅分析、不执行'))
  assert.ok(current.includes('currentSnapshot'))
  assert.ok(!current.includes('fullHostSnapshot'))
  assert.ok(current.length < before.length / 2)
  t.diagnostic(`模型可见输入字符：完整旧快照=${before.length}，下一轮保留原文与当前快照=${current.length}`)
  const saved = await h.ctx.sessionPersistence.inspect('history-group')
  assert.ok(saved.events.some(e => e.type === 'user/message' && e.surfaceOp === 'append' && JSON.stringify(e.data).includes('fullHostSnapshot')))
  assert.equal(saved.events.filter(e => e.data?.source?.groupCoordinatorHistory).length, 1)
})

test('常驻空闲挂接保留原生投影、拒绝任意模型步进，关闭释放全部句柄',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-idle-visible-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const h=await host(root,{getWorkspaceDir:()=>root,getGroupName:()=> '业务群'});t.after(()=>h.close());
 await h.sessions.run({binding:{conversationId:'g',sessionId:'visible-group',turnId:'t',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,onSessionBound:async()=>{},onCandidate:async()=>{}});
 const live=h.ctx.sessions.get('visible-group');assert.ok(live);assert.equal(h.ctx.sessionProjections.cachedSnapshot(live).values.title,'业务群');
 assert.deepEqual(h.memberships.get(root).sessionIds,['visible-group']);
 const calls=h.requests.length;const {createUserMessage}=await import('@deepseek-ai/dsh-llm');
 const agent=h.ctx.agents.get('visible-group');agent.steer(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'用户误触发送'}]}));await agent.whenIdle();assert.equal(h.requests.length,calls);
 await h.sessions.close();assert.equal(h.ctx.agents.get('visible-group'),undefined);assert.equal(h.ctx.sessions.get('visible-group'),undefined);
});


test('原生正常结束但不提交仍保持no_submission，接纳后晚到错误不否定决定',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-finish-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 for(const noSubmission of [true,false]){
  const h=await host(join(root,String(noSubmission)),{noSubmission});t.after(()=>h.close())
  let accepted=false
  const result=await h.sessions.run({binding:{conversationId:'g',sessionId:'finish-session',turnId:'turn',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,
   readTools:[{name:'read_material',effectClass:'read',description:'读取',parameters:{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:v.text}]},execute:async()=>({text:'材料'})}],
   onSessionBound:async()=>{},onCandidate:async()=>{
    accepted=true
    const session=h.ctx.sessions.get('finish-session'),snapshot=session.snapshotEvents.bind(session)
    session.snapshotEvents=()=>{const events=snapshot();return [...events,{seq:(events.at(-1)?.seq??0)+1,type:'turn/end',data:{reason:{kind:'error',error:{code:'PI_AI_ERROR',message:'Codex error: Our servers are currently overloaded. Please try again later.'}}}}]}
   }})
  assert.equal(result.status,noSubmission?'no_submission':'submitted')
  assert.equal(accepted,!noSubmission)
  if(accepted)assert.equal(h.ctx.sessions.get('finish-session').snapshotEvents().at(-1).data.reason.kind,'error')
 }
})


test('上一轮原生错误不污染本轮正常无提交',async t=>{
 const root=await mkdtemp(join(tmpdir(),'group-error-watermark-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const h=await host(root,{noSubmission:true,providerFailure:n=>n===1?{code:'PI_AI_ERROR',message:'authentication failed'}:null});t.after(()=>h.close())
 const args={binding:{conversationId:'g',sessionId:'watermark-session',turnId:'first',leaseEpoch:1,sessionBound:false},input:{},provider:'group-fixture',model:'scripted',decisionSchema,readTools:[],onSessionBound:async()=>{},onCandidate:async()=>{assert.fail('不得提交')}}
 await assert.rejects(h.sessions.run(args),{code:'GROUP_COORDINATOR_PROVIDER_FAILED'})
 h.setLease(2)
 const result=await h.sessions.run({...args,binding:{...args.binding,turnId:'second',leaseEpoch:2,sessionBound:true}})
 assert.equal(result.status,'no_submission');assert.equal(h.requests.length,2)
})
