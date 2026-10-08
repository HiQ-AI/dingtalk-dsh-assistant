import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { sessionWorkspace, taskDirectories, taskFilePath } from '../packages/dingtalk-dsh-assistant/session-workspaces.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createExecutionSessions, inspectLegacyProviderFailure } from '../packages/dingtalk-dsh-assistant/execution-session.js'
import { createAgentQueryTools, verifyAgentEvidence, readExecutedAgentQueryRefs } from '../packages/dingtalk-dsh-assistant/agent-query-tools.js'
import { createAgentResourceReadCapability } from '../packages/dingtalk-dsh-assistant/agent-query-resources.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { validateAgentWorkResult, agentWorkResultSchema, createInvestigationWorkflow } from '../packages/dingtalk-dsh-assistant/agent-work.js'

const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { SessionProjectionRegistry } = requireLoop('@deepseek-ai/dsh-session-projection')

const self = fileURLToPath(import.meta.url)
const artifacts = resolve(dirname(self), '../docs/tmp/execution-session-native')
const binding = (extra = {}) => ({ taskId: 'task', runId: 'run', nodeRunId: 'node', generation: 1, leaseEpoch: 1, inputDigest: 'input-R1', sessionId: 'session-node-r1', sessionBound: false, ...extra })
const definition = (extra = {}) => ({ provider: 'execution-fixture', model: 'scripted', prompt: 'R1_OLD_MARKER_30ba', allowedTools: ['read_fixture'], outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, ...extra })
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const submit = answer => ({ name: 'execution_node_submit', args: { output: { answer } } })
const leases = events => [...new Set(events.flatMap(event => event.type === 'dingtalk/execution-session' ? [event.data.creationLease]
  : event.type === 'user/message' && event.data.source.executionSession ? [event.data.source.executionSession.leaseEpoch] : []))]
async function temp() { await mkdir(artifacts, { recursive: true }); return mkdtemp(join(artifacts, 'run-')) }

// 只有 LlmAdapter 为脚本；每次 Host 都用真实原生 Loop、Tools、文件 JSONL 后端。
async function host({ root, script = [submit('done')], isCurrent = async () => true, repositoryInspect, tools, getWorkspaceDir } = {}) {
  root ??= await temp()
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SessionTitleService(ctx, { fallbackMaxWords: 10, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const requests = [], reads = [], effects = [], handles = []
  await writeFile(join(root, 'fixture.txt'), 'NATIVE_READ_VALUE_922d')
  ctx.on('agent/created', ({ agent }) => { handles.push(agent) })
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { ...await super.resolveModel(provider, model), reasoning: { efforts: [{ id: 'low', name: 'Low' }] } } }
    async *stream(options) {
      requests.push(JSON.parse(JSON.stringify(options)))
      const next = typeof script === 'function' ? script(requests.length) : script[requests.length - 1]
      if (!next) throw new Error('unexpected model continuation')
      if (next.providerFailure) { yield { type: 'finish', reason: { kind: 'error', failure: next.providerFailure } }; return }
      if (Array.isArray(next)) {
        for(const [index,call] of next.entries()) {
          const id=`call-${requests.length}-${index}`,args=JSON.stringify(call.args??{})
          yield {type:'block-start',index,blockType:'tool-call'}
          yield {type:'tool-call-delta',index,id,name:call.name,argumentsDelta:args}
          yield {type:'block-end',index,block:{type:'tool-call',id,name:call.name,arguments:args}}
        }
        yield {type:'finish',reason:{kind:'tool-calls'}}
      } else if (next.name) {
        const id = 'call-' + requests.length, args = JSON.stringify(next.args ?? {})
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: next.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: next.name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: next.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['execution-fixture'], new Scripted())
  ctx.tools.register({ name: 'read_fixture', description: '读取测试文件', parameters: { type: 'object' }, output,
    async execute(_args, exec) { const text = await readFile(join(root, 'fixture.txt'), { encoding: 'utf8', signal: exec.signal }); reads.push(exec.agent.session.id); return { text } },
  })
  ctx.tools.register({ name: 'unsafe_write', description: '用于拒绝测试的副作用', parameters: { type: 'object' }, output, execute() { effects.push('root-write'); return {} } })
  const manager = createExecutionSessions({ ctx, isCurrent, repositoryInspect, tools, getWorkspaceDir })
  return { ctx, root, manager, requests, reads, effects, handles, async close() { await manager.close(); await ctx.fiber.dispose() } }
}

function drive(h, extra = {}) {
  return h.manager.run({ binding: binding(), input: { requirement: 'read and submit' }, definition: definition(), onSessionBound: async () => {}, onResult: async () => {}, ...extra })
}

async function processPhase(root, phase) {
  const h = await host({ root, script: phase === 'initial' ? [{ name: 'read_fixture' }, submit('first')] : [submit('resumed')] })
  try {
    const result = await drive(h, { binding: binding({ leaseEpoch: phase === 'initial' ? 1 : 2, sessionBound: phase !== 'initial' }) })
    const persisted = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    await writeFile(join(root, phase + '.json'), JSON.stringify({ pid: process.pid, result, events: persisted.events, requests: h.requests }))
  } finally { await h.close() }
}

if (process.argv[2] === '--execution-session-child') {
  await processPhase(process.argv[3], process.argv[4])
} else {
  test('受管恢复携带诊断回到原生同会话，原输入和历史保持', async t => {
    const root = await temp()
    const first = await host({ root, script: [{ text: '本轮未能得到结论' }] })
    assert.equal((await drive(first)).reason, 'execution_no_submission')
    const prior = await first.ctx.sessionPersistence.inspect(binding().sessionId)
    await first.close()
    const next = await host({ root, script: [submit('recovered')] })
    t.after(() => next.close())
    const recoveryContext = { kind: 'execution-recovery-context', taskId: 'task', runId: 'run', nodeRunId: 'node',
      strategy: '原路径没有结果，按已登记目录读取目标材料后重新判断', evidenceRefs: ['proof/diagnosis.json'] }
    const result = await drive(next, { binding: binding({ leaseEpoch: 2, sessionBound: true }), recoveryContext })
    assert.equal(result.status, 'submitted')
    const saved = await next.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.deepEqual(saved.events.slice(0, prior.events.length), prior.events)
    assert.equal(saved.events.filter(event => event.type === 'dingtalk/execution-session').length, 1)
    const latest = saved.events.findLast(event => event.type === 'user/message' && event.data.source?.executionSession)
    assert.deepEqual(JSON.parse(latest.data.content[0].text), { requirement: 'read and submit' })
    assert.match(latest.data.content[1].text, /原路径没有结果/u)
    assert.match(JSON.stringify(next.requests[0]), /本轮未能得到结论/u)
  })
  test('原生成功查询漏引用或截短任务证据时同会话纠正，JSONL仍可重建查询集合', async t => {
    const root=await temp(),artifacts=await openExecutionArtifacts({directory:join(root,'artifacts'),initialize:true,taskWorkspaceRoot:root,getTaskDirectories:async taskId=>({logicalTaskId:taskId})})
    const capability=createAgentResourceReadCapability({resources:[{id:'source',kind:'files',root,paths:['fixture.txt']}]})
    const scope={resourceIds:['source']},[tool]=createAgentQueryTools({capabilities:[capability],resolveScope:async()=>scope,artifacts})
    let queryRef,checks=0,accepted=0
    const query={...tool,execute:async args=>{const value=await tool.execute(args);queryRef=value.evidenceRef;return value}}
    const base={outcome:'completed',summary:'已读取文件事实',evidenceRefs:['dws-source'],limitations:[],question:''}
    const h=await host({root,tools:[query],script:n=>n===1?{name:tool.name,args:{resourceId:'source',operation:'read',path:'fixture.txt'}}
      :{name:'execution_node_submit',args:{output:n===2?base:{...base,evidenceRefs:['dws-source',n===3?queryRef.split('/').at(-1):queryRef]}}}})
    t.after(()=>h.close())
    const d=definition({allowedTools:[tool.name],outputSchema:agentWorkResultSchema})
    const classifier=createInvestigationWorkflow({provider:'fixture',model:'fixture',allowedTools:[tool.name],capabilityIdentity:capability.identity,verifyResult:async()=>{}}).nodes[0].classifyOutputError
    const run=await drive(h,{definition:d,classifyOutputError:classifier,validateOutput:async value=>{
      checks++;const refs=readExecutedAgentQueryRefs(h.ctx.sessions.get(binding().sessionId).snapshotEvents(),[tool.name]);assert.deepEqual(refs,[queryRef])
      await validateAgentWorkResult(value,{sourceRefs:['dws-source'],requireCompleteCoverage:true,requireExecutedQueryAccounting:true,executedQueryRefs:refs,
        readEvidence:ref=>artifacts.read(ref),verifyEvidence:async values=>{await verifyAgentEvidence({refs:values,binding:binding(),scope,artifacts});return true}})
    },onResult:()=>{accepted++}})
    assert.equal(run.status,'submitted');assert.equal(checks,3);assert.equal(accepted,1);assert.equal(h.requests.length,4)
    assert.match(queryRef,/^tasks\/task\/sha256-/u)
    assert.ok(JSON.stringify(h.requests[3]).includes('不可截短为文件名'))
    assert.deepEqual(readExecutedAgentQueryRefs((await h.ctx.sessionPersistence.inspect(binding().sessionId)).events,[tool.name]),[queryRef])
    assert.deepEqual(readExecutedAgentQueryRefs((await h.ctx.sessionPersistence.inspect(binding().sessionId)).events,['unrelated-tool']),[])
  })
  test('原生工具缺失路径为结构化结果，不停止queued读取；模型list纠正后能提交', async t => {
    const calls=[],inspect=args=>({name:'engineering_repo_inspect',args})
    const h=await host({script:[[inspect({operation:'read',path:'src/components/Panel.vue'}),inspect({operation:'read',path:'src/other.vue'})],
      inspect({operation:'list',query:'Panel.vue'}),inspect({operation:'read',path:'src/views/review/components/Panel.vue'}),submit('corrected')],
      repositoryInspect:async(_binding,args)=>{
        calls.push(args)
        if(args.path==='src/components/Panel.vue')return {status:'not_found',code:'ENGINEERING_READ_NOT_FOUND',path:args.path,suggestedCall:{operation:'list',query:'Panel.vue'}}
        if(args.operation==='list')return {paths:['src/views/review/components/Panel.vue'],total:1,nextOffset:null}
        return {path:args.path,text:'verified source',expectedHash:'a'.repeat(64),nextOffset:null}
      }})
    t.after(()=>h.close())
    const result=await drive(h,{definition:definition({allowedTools:['engineering_repo_inspect']})})
    assert.equal(result.status,'submitted');assert.equal(result.output.answer,'corrected');assert.equal(calls.length,4)
    assert.equal(calls[1].path,'src/other.vue')
    const serialized=JSON.stringify((await h.ctx.sessionPersistence.inspect(binding().sessionId)).events)
    assert.ok(serialized.includes('ENGINEERING_READ_NOT_FOUND'));assert.ok(!serialized.includes('execution_attempt_stopped'))
  })
  test('原生工具安全门禁及普通异常仍停止会话和queued读取，不白名单泛化错误',async t=>{
    for(const code of ['ENGINEERING_READ_SCOPE_INVALID','ENGINEERING_READ_PATH_INVALID','WORKSPACE_LINK_UNSUPPORTED','EACCES','ENGINEERING_READ_STALE']){
      let calls=0
      const h=await host({script:[[{name:'engineering_repo_inspect',args:{operation:'read',path:'src/x'}},{name:'engineering_repo_inspect',args:{operation:'read',path:'src/y'}}],submit('must not submit')],repositoryInspect:async()=>{calls++;throw Object.assign(Error(code),{code})}})
      t.after(()=>h.close())
      const result=await drive(h,{definition:definition({allowedTools:['engineering_repo_inspect']})})
      assert.equal(result.status,'no_submission');assert.equal(result.reason,'execution_tool_failed')
      assert.equal(result.failure.tool,'engineering_repo_inspect');assert.match(result.failure.message,new RegExp(code))
      assert.equal(calls,1);assert.equal(h.requests.length,1)
    }
  })
  test('原生读取超限提示后可在同会话缩小分页并提交', async t => {
    const calls = []
    const h = await host({ script: [
      { name: 'engineering_repo_inspect', args: { operation: 'read', path: 'src/value.txt', limit: 19000 } },
      { name: 'engineering_repo_inspect', args: { operation: 'read', path: 'src/value.txt', limit: 16000 } }, submit('corrected-limit')],
      repositoryInspect: async (_binding, args) => {
        calls.push(args)
        return args.limit > 16000 ? { status: 'invalid_limit', code: 'ENGINEERING_READ_LIMIT_EXCEEDED', maxLimit: 16000,
          suggestedCall: { ...args, limit: 16000 } } : { text: 'source', nextOffset: null, expectedHash: 'a'.repeat(64) }
      } })
    t.after(() => h.close())
    const result = await drive(h, { definition: definition({ allowedTools: ['engineering_repo_inspect'] }) })
    assert.equal(result.status, 'submitted'); assert.equal(result.output.answer, 'corrected-limit')
    assert.deepEqual(calls.map(args => args.limit), [19000, 16000])
    assert.ok(JSON.stringify(h.requests[1]).includes('ENGINEERING_READ_LIMIT_EXCEEDED'))
  })
  test('工程只读工具在原生节点会话中可用并绑定当前运行身份', async t => {
    const calls = []
    const h = await host({ script: [{ name: 'engineering_repo_inspect', args: { operation: 'list', query: 'value' } }, submit('done')],
      repositoryInspect: async (identity, args) => { calls.push({ identity, args }); return { paths: ['src/value.txt'], total: 1, nextOffset: null } } })
    t.after(() => h.close())
    const result = await drive(h, { definition: definition({ allowedTools: ['engineering_repo_inspect'] }) })
    assert.equal(result.status, 'submitted')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].identity.runId, 'run')
    assert.deepEqual(calls[0].args, { operation: 'list', query: 'value' })
  })
  test('固定reasoningEffort透传到原生Provider请求', async t => {
    const h = await host(); t.after(() => h.close())
    const result = await drive(h, { definition: definition({ reasoningEffort: 'low' }) })
    assert.equal(h.requests.length, 1, JSON.stringify(result))
    assert.equal(h.requests[0].reasoningEffort, 'low')
  })
  test('正式适配器：两次读取同Session，先持久绑定，提交结果排空后仅回调业务output', { timeout: 10000 }, async t => {
    const h = await host({ script: [{ name: 'read_fixture' }, { name: 'read_fixture' }, submit('complete')] })
    t.after(() => h.close())
    let bound = false, completed = 0
    const result = await drive(h, {
      onSessionBound: async () => {
        assert.equal(h.requests.length, 0)
        const durable = await h.ctx.sessionPersistence.inspect(binding().sessionId)
        assert.equal(durable.events[0].type, 'dingtalk/execution-session')
        assert.equal(durable.events[0].data.identity.inputDigest, 'input-R1')
        assert.equal(durable.events[0].data.creationLease, 1)
        assert.equal(durable.events[0].ignorable, true)
        bound = true
      },
      onResult: async value => {
        assert.equal(bound, true)
        assert.deepEqual(value, { answer: 'complete' })
        assert.equal(h.ctx.agents.get(binding().sessionId), undefined)
        const durable = await h.ctx.sessionPersistence.inspect(binding().sessionId)
        assert.equal(durable.events.filter(e => e.type === 'tool/result').length, 3)
        completed++
      },
    })
    assert.deepEqual(result, { status: 'submitted', output: { answer: 'complete' } })
    assert.equal(completed, 1)
    assert.deepEqual(h.reads, [binding().sessionId, binding().sessionId])
    assert.equal(h.requests.length, 3)
    assert.ok(h.requests.every(request => request.tools.map(tool => tool.name).sort().join(',') === 'execution_node_submit,read_fixture'))
    assert.ok(JSON.stringify(h.requests[1]).includes('NATIVE_READ_VALUE_922d'))
    await delay(100)
    assert.equal(h.requests.length, 3)
    assert.equal(h.ctx.get('goals'), undefined)
  })

  test('无提交和输出schema失败均结束attempt，不反复调用模型', { timeout: 10000 }, async t => {
    for (const [script, expected] of [[[{ text: 'waiting' }], 'execution_no_submission'], [[{ name: 'execution_node_submit', args: { output: { answer: 42 }, taskId: 'forged' } }], 'execution_output_invalid']]) {
      const h = await host({ script }); t.after(() => h.close())
      let callbacks = 0
      const result = await drive(h, { onResult: async () => { callbacks++ } })
      assert.equal(result.status, 'no_submission'); assert.equal(result.reason, expected)
      await delay(60)
      assert.equal(callbacks, 0); assert.equal(h.requests.length, 1)
    }
  })

  test('受信工具参数与提交格式可在原会话修正，失败调用不进入工具体', async t => {
    const h = await host({ script: [
      { name: 'lookup_record', args: { key: 7 } },
      { name: 'lookup_record', args: { key: 'record-1' } },
      { name: 'execution_node_submit', args: { output: { answer: 42 } } },
      submit('corrected'),
    ] })
    t.after(() => h.close())
    let executed = 0, submitted = 0
    h.ctx.tools.register({ name: 'lookup_record', description: '读取受信记录',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      output, execute: args => { executed++; return { key: args.key, value: 'known' } } })
    const result = await drive(h, { definition: definition({ allowedTools: ['lookup_record'], maxSteps: 4 }),
      onResult: async () => { submitted++ } })
    assert.deepEqual(result, { status: 'submitted', output: { answer: 'corrected' } })
    assert.equal(executed, 1)
    assert.equal(submitted, 1)
    assert.equal(h.requests.length, 4)
    assert.ok(JSON.stringify(h.requests[1]).includes('execution_arguments_invalid'))
    assert.ok(JSON.stringify(h.requests[3]).includes('execution_arguments_invalid'))
    const history = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.deepEqual(leases(history.events), [1])
    assert.ok(JSON.stringify(history.events).includes('execution_arguments_invalid'))
  })

  test('连续格式纠正超过旧步数上限后仍可提交', async t => {
    const h = await host({ script: n => n <= 40 ? ({ name: 'execution_node_submit', args: { output: { answer: 42 } } }) : submit('corrected') })
    t.after(() => h.close())
    let submitted = 0
    const result = await drive(h, { definition: definition({ maxSteps: 2 }), onResult: async () => { submitted++ } })
    assert.equal(result.status, 'submitted')
    assert.equal(h.requests.length, 41)
    assert.equal(submitted, 1)
  })

  test('参数修正不能覆盖后置权限拒绝，也不能改写已接纳提交', async t => {
    const h = await host({ script: [{ name: 'execution_node_submit', args: { output: { answer: 42 } } }, submit('forbidden')] })
    t.after(() => h.close())
    h.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'authorization revoked' }] }))
    const rejected = await drive(h)
    assert.equal(rejected.status, 'no_submission'); assert.equal(rejected.reason, 'execution_submission_rejected')
    assert.equal(rejected.failure.tool, 'execution_node_submit')
    assert.equal(h.requests.length, 1)
    const accepted = await host({ script: [[submit('first'), submit('second')]] })
    t.after(() => accepted.close())
    const outputs = []
    const result = await drive(accepted, { onResult: async value => outputs.push(value) })
    assert.ok(result.status !== 'submitted' || result.output.answer === 'first')
    assert.ok(outputs.every(value => value.answer === 'first'))
    assert.equal(accepted.requests.length, 1)
  })

  test('restrict隐藏继承写工具，单调guard拒绝scope-local写和恶意调用', { timeout: 10000 }, async t => {
    const h = await host({ script: [{ name: 'unsafe_write' }] }); t.after(() => h.close())
    h.ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.register({ name: 'unsafe_write', description: 'scope本地绕过restrict展示的反例', parameters: { type: 'object' }, output, execute() { h.effects.push('local-write'); return {} } })
      agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    })
    const result = await drive(h)
    assert.equal(result.status, 'no_submission')
    assert.equal(result.reason, 'execution_tool_not_allowed')
    assert.deepEqual(h.effects, [])
    assert.equal(h.requests.length, 1)
    const stored = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.ok(JSON.stringify(stored.events).includes('execution_tool_not_allowed'))
  })

  test('首step与submit前检查当前租约；过期状态不交付业务output', { timeout: 10000 }, async t => {
    let current = true
    const h = await host({ isCurrent: async () => current }); t.after(() => h.close())
    let submitted = 0
    const result = await drive(h, { onSessionBound: async () => { current = false }, onResult: async () => { submitted++ } })
    assert.equal(result.status, 'stale'); assert.equal(h.requests.length, 0); assert.equal(submitted, 0)
    const h2 = await host(); t.after(() => h2.close())
    let fence = true
    const scoped = createExecutionSessions({ ctx: h2.ctx, isCurrent: async () => fence })
    t.after(() => scoped.close())
    h2.ctx.on('tools/post-execute', async (_exec, _result, next) => { fence = false; return next() })
    const second = await scoped.run({ binding: binding(), input: {}, definition: definition(), onSessionBound: async () => {}, onResult: async () => { submitted++ } })
    assert.equal(second.status, 'stale'); assert.equal(submitted, 0)
  })

  test('bound Session缺失或既有Session身份未知不得新建/认领', { timeout: 10000 }, async t => {
    const h = await host(); t.after(() => h.close())
    await assert.rejects(drive(h, { binding: binding({ sessionBound: true }) }), { code: 'execution_session_missing' })
    assert.equal(h.ctx.sessions.get(binding().sessionId), undefined)
    const foreign = await h.ctx.agents.create({ sessionId: binding().sessionId })
    foreign.agent.session.append('session/title', { title: 'unrelated' })
    await h.ctx.sessions.flush(foreign.agent.session); await foreign.dispose()
    await assert.rejects(drive(h), { code: 'execution_session_identity_mismatch' })
    assert.equal(h.requests.length, 0)
  })

  test('create后bind失败：持久身份可恢复，须递增lease；同身份错digest仍拒绝', { timeout: 10000 }, async t => {
    const h = await host(); t.after(() => h.close())
    await assert.rejects(drive(h, { onSessionBound: async () => { throw new Error('control_store_unavailable') } }), /control_store_unavailable/)
    assert.equal(h.requests.length, 0)
    await assert.rejects(drive(h), { code: 'execution_session_lease_not_advanced' })
    await assert.rejects(drive(h, { binding: binding({ inputDigest: 'wrong', leaseEpoch: 2 }) }), { code: 'execution_session_identity_mismatch' })
    const result = await drive(h, { binding: binding({ leaseEpoch: 2, sessionBound: false }) })
    assert.equal(result.status, 'submitted')
    const stored = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.equal(stored.events.filter(e => e.type === 'dingtalk/execution-session').length, 1)
    assert.deepEqual(leases(stored.events), [1, 2])
  })

  test('R1输入失效后新generation新Session实际请求不含旧规则或历史', { timeout: 10000 }, async t => {
    const h = await host({ script: [submit('first'), submit('second')] }); t.after(() => h.close())
    await drive(h)
    await drive(h, { binding: binding({ sessionId: 'session-node-r2', generation: 2, inputDigest: 'input-R2', leaseEpoch: 2 }), definition: definition({ prompt: 'R2_NEW_MARKER_591c' }) })
    assert.ok(JSON.stringify(h.requests[0]).includes('R1_OLD_MARKER_30ba'))
    assert.ok(JSON.stringify(h.requests[1]).includes('R2_NEW_MARKER_591c'))
    assert.ok(!JSON.stringify(h.requests[1]).includes('R1_OLD_MARKER_30ba'))
    assert.ok(!JSON.stringify(h.requests[1]).includes('"answer":"first"'))
  })

  test('真实post-execute未结束不回调；取消和close等待工具退出，期间不能创建替身', { timeout: 10000 }, async t => {
    const h = await host()
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(async () => { release.resolve(); await h.close() })
    h.ctx.on('tools/post-execute', async (exec, _result, next) => { if (exec.name === 'execution_node_submit') { entered.resolve(); await release.promise }; return next() })
    let callbacks = 0
    const running = drive(h, { onResult: async () => { callbacks++ } })
    await entered.promise
    let cancelled = false
    const cancellation = h.manager.cancel(binding().runId).then(() => { cancelled = true })
    await delay(70)
    assert.equal(callbacks, 0); assert.equal(cancelled, false)
    assert.ok(h.ctx.agents.get(binding().sessionId))
    await assert.rejects(drive(h, { binding: binding({ leaseEpoch: 2 }) }), { code: 'execution_run_busy', executionDrained: false })
    assert.throws(() => h.manager.assertDrained(binding()), { code: 'execution_run_busy', executionDrained: false })
    release.resolve()
    await cancellation
    assert.deepEqual(await running, { status: 'cancelled' })
    assert.equal(callbacks, 0); assert.equal(h.requests.length, 1)
    assert.equal(h.ctx.agents.get(binding().sessionId), undefined)
    assert.equal(h.manager.assertDrained(binding()), true)
    const durable = await h.ctx.sessionPersistence.inspect(binding().sessionId)
    assert.equal(durable.events.filter(e => e.type === 'tool/result').length, 1)

    const h2 = await host({ script: [{ name: 'held_read' }, { name: 'unsafe_write' }] })
    const toolEntered = Promise.withResolvers(), toolExit = Promise.withResolvers()
    h2.ctx.tools.register({ name: 'held_read', description: '可取消但须等待退出的实际异步工具', parameters: { type: 'object' }, output,
      async execute(_args, exec) { toolEntered.resolve(); await toolExit.promise; exec.signal.throwIfAborted(); return {} },
    })
    t.after(async () => { toolExit.resolve(); await h2.close() })
    const active = drive(h2, { definition: definition({ allowedTools: ['held_read', 'unsafe_write'] }) })
    await toolEntered.promise
    let closed = false
    const closing = h2.manager.close().then(() => { closed = true })
    await delay(70); assert.equal(closed, false)
    toolExit.resolve(); await closing
    assert.deepEqual(await active, { status: 'cancelled' })
    assert.equal(h2.requests.length, 1); assert.deepEqual(h2.effects, [])
  })

  test('实际JSONL跨OS进程恢复正式模块：原日志前缀不变，lease增加，旧工具结果进入新请求', { timeout: 15000 }, async () => {
    const root = await temp()
    for (const phase of ['initial', 'resume']) {
      const child = spawn(process.execPath, [self, '--execution-session-child', root, phase], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk })
      child.stdout.resume()
      const exit = await new Promise((resolveChild, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveChild({ code, signal })) })
      assert.equal(exit.code, 0, stderr)
    }
    const initial = JSON.parse(await readFile(join(root, 'initial.json'), 'utf8'))
    const resumed = JSON.parse(await readFile(join(root, 'resume.json'), 'utf8'))
    assert.notEqual(initial.pid, resumed.pid)
    assert.deepEqual(resumed.events.slice(0, initial.events.length), initial.events)
    assert.deepEqual(leases(resumed.events), [1, 2])
    assert.equal(resumed.events.filter(e => e.type === 'dingtalk/execution-session').length, 1)
    assert.equal(resumed.requests.length, 1)
    assert.ok(JSON.stringify(resumed.requests[0]).includes('NATIVE_READ_VALUE_922d'))
    assert.equal(resumed.result.status, 'submitted')
  })

  test('超过旧步数限制持续读取，显式取消仍等待真实工具排空', { timeout: 20000 }, async t => {
    const h = await host({ script: n => n <= 40 ? ({ name: 'read_fixture' }) : submit('complete') }); t.after(() => h.close())
    const result = await drive(h)
    assert.equal(result.status, 'submitted'); assert.equal(h.reads.length, 40)
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const slow = await host({ script: [{ name: 'slow_tool' }] }); t.after(async () => { release.resolve(); await slow.close() })
    slow.ctx.tools.register({ name: 'slow_tool', description: '取消后排空', parameters: { type: 'object' }, output,
      async execute(_args, exec) { entered.resolve(); await release.promise; exec.signal.throwIfAborted(); return {} } })
    let completed = false
    const active = drive(slow, { definition: definition({ allowedTools: ['slow_tool'] }) }).then(value => { completed = true; return value })
    await entered.promise
    const cancelling = slow.manager.cancel(binding())
    await delay(30); assert.equal(completed, false)
    release.resolve(); await cancelling
    assert.equal((await active).status, 'cancelled')
  })

  test('定义仅快照执行字段；排空持久化失败明确标记未证明排空并保留占位', { timeout: 10000 }, async t => {
    const h = await host(); t.after(() => h.ctx.fiber.dispose())
    let failFlush = false
    h.ctx.on('session/flush', () => { if (failFlush) throw new Error('durability_unavailable') })
    await assert.rejects(drive(h, { definition: definition({ mapInput: () => ({}) }), onSessionBound: async () => { failFlush = true } }), { code: 'execution_session_drain_failed', executionDrained: false })
    await assert.rejects(h.manager.cancel(binding().runId), { code: 'execution_session_drain_failed', executionDrained: false })
    await assert.rejects(drive(h, { binding: binding({ leaseEpoch: 2 }) }), { code: 'execution_run_busy' })
    failFlush = false
  })

  test('未知所有者的真实原生句柄拒绝标记未排空，cancel与恢复检查不得取消或认领它', { timeout: 10000 }, async t => {
    const h = await host({ script: [{ name: 'foreign_hold' }, { text: 'finished' }] })
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    let exited = false, aborted = false, foreign
    t.after(async () => { release.resolve(); await foreign?.dispose(); await h.close() })
    h.ctx.tools.register({ name: 'foreign_hold', description: '另一所有者的原生在途工具', parameters: { type: 'object' }, output,
      async execute(_args, exec) { entered.resolve(); await release.promise; aborted = exec.signal.aborted; exited = true; return {} },
    })
    foreign = await h.ctx.agents.create({ sessionId: binding().sessionId, agentOptions: { provider: 'execution-fixture', model: 'scripted' } })
    foreign.agent.steer(createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: 'foreign owner' }] }))
    await entered.promise
    await assert.rejects(drive(h, { binding: binding({ sessionBound: true, leaseEpoch: 2 }) }), { code: 'execution_session_already_live', executionDrained: false })
    await h.manager.cancel(binding().runId)
    assert.equal(h.ctx.agents.get(binding().sessionId), foreign.agent)
    assert.equal(foreign.agent.status, 'running'); assert.equal(exited, false)
    assert.throws(() => h.manager.assertDrained(binding()), { code: 'execution_session_already_live', executionDrained: false })
    release.resolve(); await foreign.agent.whenIdle()
    assert.equal(aborted, false, '适配器不能取消未知所有者的原生句柄')
    assert.throws(() => h.manager.assertDrained(binding()), { code: 'execution_session_already_live', executionDrained: false })
    await foreign.dispose()
    assert.equal(h.manager.assertDrained(binding()), true)
    assert.equal(h.manager.assertDrained({ runId: 'code-run', sessionId: null }), true)
  })
}

if (process.argv[2] !== '--execution-session-child') {
const messageBinding = (extra = {}) => ({ kind: 'message-unit', runId: 'message-run', unitId: 'unit-1', inputVersion: 1,
  inputDigest: 'message-digest', sessionId: 'message-session', sessionBound: false, leaseEpoch: 1, ...extra })

test('消息原生会话：查询纠正、提交和跨Host补充恢复，无虚假任务身份', async t => {
  const root = await temp(), seen = []
  const tool = { name: 'project_query', description: 'query project', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    async execute({ binding, args }) { seen.push(binding); if (args.path === 'missing') throw Object.assign(Error('choose another path'), { code: 'NOT_FOUND' }); return { text: 'source evidence' } },
    classifyError: error => error.code === 'NOT_FOUND' ? 'correctable' : 'fatal' }
  const h = await host({ root, tools: [tool], script: [{ name: 'project_query', args: { path: 'missing' } }, { name: 'project_query', args: { path: 'real' } }, submit('verified')] })
  const result = await drive(h, { binding: messageBinding(), definition: definition({ allowedTools: ['project_query'] }) })
  assert.equal(result.status, 'submitted'); assert.equal(seen.length, 2)
  assert.ok(seen.every(value => value.kind === 'message-unit' && !Object.hasOwn(value, 'taskId')))
  assert.ok(JSON.stringify(h.requests[1]).includes('correctable_error'))
  const first = await h.ctx.sessionPersistence.inspect('message-session')
  assert.equal(first.events[0].data.version, 2)
  await h.close()
  const next = await host({ root, tools: [tool], script: [submit('continued')] }); t.after(() => next.close())
  const resumed = messageBinding({ sessionBound: true, leaseEpoch: 2, inputVersion: 2, inputDigest: 'clarified-input' })
  assert.equal((await drive(next, { binding: resumed, definition: definition({ allowedTools: ['project_query'] }) })).status, 'submitted')
  const history = await next.ctx.sessionPersistence.inspect('message-session')
  assert.deepEqual(history.events.slice(0, first.events.length), first.events)
  await assert.rejects(drive(next, { binding: messageBinding({ taskId: 'fake' }) }), { code: 'execution_binding_invalid' })
  await assert.rejects(drive(next, { binding: messageBinding({ leaseEpoch: 3 }) }), { code: 'execution_session_identity_mismatch' })
})

test('受信工具安全失败中止queued调用', async t => {
  let calls = 0
  const h = await host({ tools: [{ name: 'query', description: 'query', parameters: { type: 'object' }, execute() { calls++; throw Object.assign(Error('denied'), { code: 'DENIED' }) }, classifyError: () => 'fatal' }],
    script: [[{ name: 'query' }, { name: 'query' }], submit('forbidden')] })
  t.after(() => h.close())
  assert.deepEqual(await drive(h, { binding: messageBinding(), definition: definition({ allowedTools: ['query'] }) }), { status: 'no_submission', reason: 'execution_tool_failed', failure: { code: 'DENIED', tool: 'query', phase: 'execution', message: 'denied' } })
  assert.equal(calls, 1); assert.equal(h.requests.length, 1)
})

test('消息原生恢复不受累计步数截止，仍保持会话身份', async t => {
  const h = await host({ script: [submit('first'), submit('resumed')] }); t.after(() => h.close())
  const d = definition({ allowedTools: [], maxSteps: 1 })
  assert.equal((await drive(h, { binding: messageBinding(), definition: d })).status, 'submitted')
  assert.equal((await drive(h, { binding: messageBinding({ sessionBound: true, leaseEpoch: 2 }), definition: d })).status, 'submitted')
  assert.equal(h.requests.length, 2)
})


test('消息取消会排空受信工具并拒绝迟到产出，工具不能软化取消', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let completed = 0, classified = 0
  const h = await host({ tools: [{ name: 'slow_query', description: 'slow query', parameters: { type: 'object' },
    async execute() { entered.resolve(); await release.promise; return { value: 'late' } }, classifyError() { classified++; return 'correctable' } }],
    script: [{ name: 'slow_query' }, submit('late')] })
  t.after(async () => { release.resolve(); await h.close() })
  const running = drive(h, { binding: messageBinding(), definition: definition({ allowedTools: ['slow_query'] }), onResult() { completed++ } })
  await entered.promise
  const cancelling = h.manager.cancel(messageBinding())
  assert.throws(() => h.manager.assertDrained(messageBinding()), { code: 'execution_run_busy' })
  release.resolve(); await cancelling
  assert.equal((await running).status, 'cancelled'); assert.equal(completed, 0); assert.equal(classified, 0)
  assert.equal(h.manager.assertDrained(messageBinding()), true)
})

test('消息恢复累计timeout，完成后的等待时间不占执行预算', async t => {
  const root = await temp()
  const h = await host({ root, tools: [{ name: 'slow_query', description: 'slow query', parameters: { type: 'object' }, async execute() { await delay(100); return {} } }],
    script: [{ name: 'slow_query' }, submit('first')] })
  const d = definition({ allowedTools: ['slow_query'], timeoutMs: 2000 })
  assert.equal((await drive(h, { binding: messageBinding(), definition: d })).status, 'submitted')
  await h.close()
  await delay(2100)
  const next = await host({ root, tools: [{ name: 'slow_query', description: 'slow query', parameters: { type: 'object' }, async execute() { return {} } }], script: [submit('after-wait')] }); t.after(() => next.close())
  assert.equal((await drive(next, { binding: messageBinding({ leaseEpoch: 2, sessionBound: true }), definition: d })).status, 'submitted')
  assert.equal(next.requests.length, 1)
})


test('消息续接不受累计执行时长截止', async t => {
  const slow = { name: 'slow_query', description: 'slow query', parameters: { type: 'object' }, async execute({ signal }) { await delay(1200, undefined, { signal }); return {} } }
  const root = await temp(), d = definition({ allowedTools: ['slow_query'], timeoutMs: 2000 })
  const first = await host({ root, tools: [slow], script: [{ name: 'slow_query' }, submit('first')] })
  assert.equal((await drive(first, { binding: messageBinding(), definition: d })).status, 'submitted')
  await first.close()
  const next = await host({ root, tools: [slow], script: [{ name: 'slow_query' }, submit('must not finish')] }); t.after(() => next.close())
  const result = await drive(next, { binding: messageBinding({ leaseEpoch: 2, sessionBound: true }), definition: d })
  assert.equal(result.status, 'submitted'); assert.equal(next.requests.length, 2)
})


test('显式调查节点同Session补充：Host历史逐项匹配，任务身份及代际不变', async t => {
  const h = await host({ script: [submit('need environment'), submit('answered with UAT2')] }); t.after(() => h.close())
  const first = binding({ kind: 'task-node', inputVersion: 1, inputHistory: [] })
  assert.equal((await drive(h, { binding: first })).status, 'submitted')
  const prior = await h.ctx.sessionPersistence.inspect(first.sessionId)
  const second = { ...first, inputVersion: 2, inputDigest: 'input-with-environment', inputHistory: [{ inputVersion: 1, inputDigest: first.inputDigest }], leaseEpoch: 2, sessionBound: true }
  assert.equal((await drive(h, { binding: second, input: { environment: 'uat2' } })).status, 'submitted')
  const resumed = await h.ctx.sessionPersistence.inspect(first.sessionId)
  assert.deepEqual(resumed.events.slice(0, prior.events.length), prior.events)
  const turns = resumed.events.filter(event => event.type === 'user/message').map(event => event.data.source.executionSession)
  assert.deepEqual(turns.map(turn => [turn.inputVersion, turn.inputDigest, turn.leaseEpoch]), [[1, 'input-R1', 1], [2, 'input-with-environment', 2]])
  assert.ok(JSON.stringify(h.requests[1]).includes('need environment'))
  for (const changed of [{ generation: 2 }, { nodeRunId: 'different-node' }, { taskId: 'different-task' }, { inputDigest: 'unauthorized-same-version' }, { inputHistory: [{ inputVersion: 1, inputDigest: 'forged-prior' }] }])
    await assert.rejects(drive(h, { binding: { ...second, ...changed, leaseEpoch: 3 } }), { code: 'execution_session_identity_mismatch' })
})

test('普通工程session不能借添加补充合同更改digest，调查不能删除合同或跳过历史版本', async t => {
  const h = await host(); t.after(() => h.close())
  const ordinary = binding({ kind: 'task-node' })
  await drive(h, { binding: ordinary })
  await assert.rejects(drive(h, { binding: { ...ordinary, inputVersion: 2, inputHistory: [{ inputVersion: 1, inputDigest: ordinary.inputDigest }], inputDigest: 'new', leaseEpoch: 2 } }), { code: 'execution_session_identity_mismatch' })
  await assert.rejects(drive(h, { binding: binding({ inputVersion: 1, inputHistory: [] }) }), { code: 'execution_binding_invalid' })
  await assert.rejects(drive(h, { binding: { ...ordinary, inputVersion: 3, inputHistory: [{ inputVersion: 1, inputDigest: ordinary.inputDigest }], leaseEpoch: 2 } }), { code: 'execution_binding_invalid' })
  const fresh = await host(); t.after(() => fresh.close())
  await drive(fresh, { binding: binding({ kind: 'task-node', inputVersion: 1, inputHistory: [] }) })
  await assert.rejects(drive(fresh, { binding: binding({ kind: 'task-node', leaseEpoch: 2 }) }), { code: 'execution_session_identity_mismatch' })
})

test('调查补充保持同会话继续，不受累计步数截止', async t => {
  const h = await host({ script: [submit('first'), submit('supplemented')] }); t.after(() => h.close())
  const first = binding({ kind: 'task-node', inputVersion: 1, inputHistory: [] }), d = definition({ maxSteps: 1 })
  await drive(h, { binding: first, definition: d })
  assert.equal((await drive(h, { binding: { ...first, leaseEpoch: 2, inputVersion: 2, inputDigest: 'supplemented', inputHistory: [{ inputVersion: 1, inputDigest: first.inputDigest }] }, definition: d })).status, 'submitted')
  assert.equal(h.requests.length, 2)
})


test('Host输出语义校验可纠正错误在conclude前反馈，修正才接纳且不泄露路径', async t => {
  const h = await host({ script: [submit('sourceRefs'), submit('evidenceRef')] }); t.after(() => h.close())
  const checked = [], accepted = []
  const result = await drive(h, { validateOutput(value) { checked.push(value.answer); if (value.answer === 'sourceRefs') throw Object.assign(new Error('secret/path.json'), { code: 'BAD_REF' }) },
    classifyOutputError: error => error.code === 'BAD_REF' ? 'correctable' : 'fatal', onResult: value => accepted.push(value) })
  assert.equal(result.status, 'submitted'); assert.deepEqual(checked, ['sourceRefs', 'evidenceRef']); assert.deepEqual(accepted, [{ answer: 'evidenceRef' }])
  const feedback = JSON.stringify(h.requests[1]); assert.ok(feedback.includes('execution_output_needs_correction')); assert.ok(!feedback.includes('secret/path.json'))
})

test('Host输出校验默认fatal，校验期间失效的lease不可软化', async t => {
  for (const stale of [false, true]) {
    let current = true, classified = 0, accepted = 0
    const h = await host({ isCurrent: async () => current, script: [submit('invalid'), submit('should not run')] }); t.after(() => h.close())
    const result = await drive(h, { validateOutput() { if (stale) current = false; throw new Error('invalid') },
      ...(stale ? { classifyOutputError() { classified++; return 'correctable' } } : {}), onResult() { accepted++ } })
    assert.notEqual(result.status, 'submitted'); assert.equal(h.requests.length, 1); assert.equal(accepted, 0); assert.equal(classified, 0)
  }
})


test('新原生会话使用Host工作区meta，模型input不能覆盖；恢复保持原metadata', async t => {
  const root = await temp(), workspace = await sessionWorkspace(resolve(root), 'execution'); let lookups = 0; const h = await host({ root, getWorkspaceDir: () => { lookups++; return workspace }, script: [submit('first'), submit('second')] }); t.after(() => h.close())
  await drive(h, { input: { request: '核对草稿字段', cwd: resolve('docs'), workspaceDir: resolve('test') } })
  const initial = await h.ctx.sessionPersistence.inspect(binding().sessionId)
  assert.equal(initial.meta.cwd, workspace)
  assert.equal(initial.events.findLast(event => event.type === 'session/title').data.title, '核对草稿字段 · 任务执行')
  await drive(h, { binding: binding({ leaseEpoch: 2, sessionBound: true }) })
  assert.equal((await h.ctx.sessionPersistence.inspect(binding().sessionId)).meta.cwd, workspace)
  assert.equal(lookups, 1)
  const invalid = await host({ getWorkspaceDir: () => 'relative/path' }); t.after(() => invalid.close())
  await assert.rejects(drive(invalid), { code: 'execution_workspace_invalid' })
  assert.equal(invalid.requests.length, 0)
})

test('同消息不同unit原生并行且取消只排空目标unit',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers()
 const h=await host({tools:[{name:'hold',description:'hold',parameters:{type:'object',properties:{}},execute:async()=>{entered.resolve();await release.promise;return {ok:true}}}],script:n=>n===1?{name:'hold',args:{}}:submit('second')});t.after(()=>h.close())
 const first=drive(h,{binding:messageBinding(),definition:definition({allowedTools:['hold']})})
 await entered.promise
 const secondBinding=messageBinding({unitId:'unit-2',sessionId:'message-session-2'})
 const second=await drive(h,{binding:secondBinding,definition:definition({allowedTools:['hold']})})
 assert.equal(second.status,'submitted')
 await assert.rejects(drive(h,{binding:messageBinding({sessionId:'duplicate-unit-session'})}),{code:'execution_run_busy'})
 const cancelling=h.manager.cancel(messageBinding());release.resolve();await cancelling
 assert.equal((await first).status,'cancelled')
 assert.equal(h.manager.assertDrained(messageBinding()),true)
 assert.equal(h.manager.assertDrained(secondBinding),true)
 assert.ok((await h.ctx.sessionPersistence.inspect(secondBinding.sessionId)).events.some(e=>e.type==='tool/result'))
})


test('任务原生节点工作目录隔离，宿主重启恢复原cwd且原始日志仍位于sessions根', async t => {
  const root = await temp(), selected = []
  const identities = [binding({ taskId: 'task-a', runId: 'run-a', nodeRunId: 'node-a', sessionId: 'session-a' }),
    binding({ taskId: 'task-a', runId: 'run-a2', nodeRunId: 'node-b', sessionId: 'session-b' }),
    binding({ taskId: 'task-b', runId: 'run-b', nodeRunId: 'node-a', sessionId: 'session-c' })]
  const h = await host({ root, script: () => submit('isolated'), getWorkspaceDir: async ({ binding: current, input }) => {
    selected.push({ taskId: current.taskId, nodeRunId: current.nodeRunId, input })
    await taskDirectories(root, current.taskId)
    const directory = taskFilePath(root, current.taskId, 'work', current.nodeRunId)
    await mkdir(directory, { recursive: true })
    return directory
  } })
  t.after(() => h.close())
  const locations = []
  for (const identity of identities) {
    assert.equal((await drive(h, { binding: identity, input: { request: '目录隔离', taskId: 'forged', cwd: root } })).status, 'submitted')
    const saved = await h.ctx.sessionPersistence.inspect(identity.sessionId)
    const expected = taskFilePath(root, identity.taskId, 'work', identity.nodeRunId)
    assert.equal(saved.meta.cwd, expected)
    await writeFile(join(expected, 'draft.txt'), identity.sessionId)
    const location = h.ctx.sessionPersistence.locate(saved.meta).path
    assert.ok(location.startsWith(join(root, 'sessions') + sep))
    assert.ok(!(location.startsWith(join(root, 'tasks') + sep)))
    assert.match(await readFile(location, 'utf8'), /dingtalk\/execution-session/)
    locations.push(location)
  }
  assert.deepEqual(selected.map(({ taskId, nodeRunId }) => ({ taskId, nodeRunId })),
    identities.map(({ taskId, nodeRunId }) => ({ taskId, nodeRunId })))
  assert.equal(new Set(locations).size, 3)
  for (const identity of identities)
    assert.equal(await readFile(join(taskFilePath(root, identity.taskId, 'work', identity.nodeRunId), 'draft.txt'), 'utf8'), identity.sessionId)
  await h.close()
  const resumed = await host({ root, getWorkspaceDir: () => { throw new Error('must not reselect persisted cwd') } })
  t.after(() => resumed.close())
  assert.equal((await drive(resumed, { binding: { ...identities[0], leaseEpoch: 2, sessionBound: true } })).status, 'submitted')
  const saved = await resumed.ctx.sessionPersistence.inspect(identities[0].sessionId)
  assert.equal(saved.meta.cwd, taskFilePath(root, 'task-a', 'work', 'node-a'))
  assert.equal(resumed.ctx.sessionPersistence.locate(saved.meta).path, locations[0])
  assert.deepEqual(leases(saved.events), [1, 2])
})

}

test('只读范围拒绝保留拒绝后可调整合法查询，不终止整个调查', async t => {
  const { classifyAgentQueryError } = await import('../packages/dingtalk-dsh-assistant/agent-query-tools.js')
  const seen = []
  const h = await host({ tools: [{ name: 'query', description: 'readonly', parameters: { type: 'object' }, classifyError: classifyAgentQueryError,
    execute({ args }) { if (args.path === 'forbidden') throw Object.assign(Error('QUERY_SCOPE_DENIED'), { code: 'QUERY_SCOPE_DENIED' }); seen.push(args.path); return { text: 'verified' } } }],
    script: [{ name: 'query', args: { path: 'forbidden' } }, { name: 'query', args: { path: 'allowed' } }, submit('done')] })
  t.after(() => h.close())
  assert.equal((await drive(h, { definition: definition({ allowedTools: ['query'] }) })).status, 'submitted')
  assert.deepEqual(seen, ['allowed'])
  assert.match(JSON.stringify(h.requests[1]), /QUERY_SCOPE_DENIED/u)
})

for (const [message, expected] of [
  ['Codex error: Our servers are currently overloaded. Please try again later.\n[Codex diagnostics: {"httpStatus":200}]', 'EXECUTION_PROVIDER_TRANSIENT'],
  ['Codex error: authentication failed', 'EXECUTION_PROVIDER_FAILED'],
]) test(`原生执行保留本轮provider错误并区分暂态：${expected}`, async t => {
  const h = await host({ script: [{ providerFailure: { code: 'PI_AI_ERROR', message } }, { text: '正常结束未提交' }] })
  t.after(() => h.close())
  const first = await drive(h)
  assert.equal(first.reason, expected)
  assert.equal(first.failure.phase, 'provider')
  assert.equal(first.failure.message, message)
  const second = await drive(h, { binding: binding({ leaseEpoch: 2, sessionBound: true }) })
  assert.equal(second.reason, 'execution_no_submission')
  assert.equal(second.failure, undefined)
})
test('已接纳节点提交优先于稍后的provider错误', async t => {
  const h = await host({ script: [submit('accepted')] }); t.after(() => h.close())
  let completed = 0
  const result = await drive(h, { onSessionBound() {
    const session = h.ctx.sessions.get(binding().sessionId), snapshot = session.snapshotEvents.bind(session)
    session.snapshotEvents = () => {
      const events = snapshot()
      return events.some(event => event.type === 'turn/end') ? [...events, { seq: events.at(-1).seq + 1, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Codex error: Our servers are currently overloaded. Please try again later.' } } } }] : events
    }
  }, onResult() { completed++ } })
  assert.deepEqual(result, { status: 'submitted', output: { answer: 'accepted' } })
  assert.equal(completed, 1)
})

test('旧provider失败只读重分类核对原生身份、本轮租约及未提交', async t => {
  const message = 'Codex error: Our servers are currently overloaded. Please try again later.'
  const h = await host({ script: [{ providerFailure: { code: 'PI_AI_ERROR', message } }] }); t.after(() => h.close())
  await drive(h)
  const b = binding({ sessionBound: true }), proof = await inspectLegacyProviderFailure(h.ctx, b)
  assert.equal(proof.failure.code, 'EXECUTION_PROVIDER_TRANSIENT')
  await assert.rejects(inspectLegacyProviderFailure(h.ctx, { ...b, inputDigest: 'forged' }), { code: 'execution_session_identity_mismatch' })
  assert.equal(await inspectLegacyProviderFailure(h.ctx, { ...b, leaseEpoch: 2 }), null)
  const stored = await h.ctx.sessionPersistence.inspect(b.sessionId)
  for (const extra of [
    { type: 'user/message', data: { source: { kind: 'web' } } },
    { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'coordinator', executionSession: { sessionId: b.sessionId, leaseEpoch: 1 } } }] } },
    { type: 'tool/result', data: { name: 'execution_node_submit' } },
  ]) {
    const ctx = { agents: { get() {} }, sessions: { get() {} }, sessionPersistence: { inspect: async () => ({ events: [...stored.events, { ...extra, seq: stored.events.at(-1).seq + 1 }] }) } }
    assert.equal(await inspectLegacyProviderFailure(ctx, b), null)
  }
  assert.equal(await inspectLegacyProviderFailure({ ...h.ctx, agents: { get: () => ({}) } }, b), null)
})
