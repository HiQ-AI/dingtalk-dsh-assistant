import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { available, reason, nativeTaskHost, topicSummaryResponse, contextReadResponse, nativeVerificationTeam, latestInput } from './fixtures/task-session-native-host.js'
import { createTaskSessions } from '../packages/dingtalk-dsh-assistant/task-session.js'
import { taskModelSelection } from '../packages/dingtalk-dsh-assistant/task-model-config.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

function installModel(ctx, providers, decide, requests) {
  const profile = createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE)))
  const native = createRequire(profile.resolve('@deepseek-ai/dsh-base'))
  const { LlmAdapter } = native('@deepseek-ai/dsh-llm')
  let sequence = 0
  const auxiliaryRequests = []
  class ReasoningModel extends LlmAdapter {
    resolveModel(provider, model) { return { provider, id: model, name: model,
      reasoning: { efforts: ['low','medium','high'].map(id => ({ id, name:id })), defaultEffort: 'medium' } } }
    async *stream(request) {
      if (yield* topicSummaryResponse(request, auxiliaryRequests)) return
      if (yield* contextReadResponse(request)) return
      requests.push(structuredClone(request))
      const calls = await decide(request)
      for (const [index,call] of calls.entries()) {
        const id = `reasoning-${++sequence}`, args = JSON.stringify(call.args)
        yield { type:'block-start', index, blockType:'tool-call' }
        yield { type:'tool-call-delta', index, id, name:call.name, argumentsDelta:args }
        yield { type:'block-end', index, block:{ type:'tool-call', id, name:call.name, arguments:args } }
      }
      yield { type:'finish', reason:{ kind:calls.length ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(providers,new ReasoningModel())
}
const decision = action => ({ name:'task_session_submit', args:{ decision:{ action,summary:'核对原任务结果',evidence:[],limitations:[] } } })

test('native owner inherits old depth, keeps in-flight depth and switches only on same-session resume; model default and unsupported differ',
  { ...({skip:!available ? reason : false,timeout:30000}), timeout: nativeLifecycleTimeout(30000) },nativeLifecycle(30000, async (t) => {
    const root = await mkdtemp(join(tmpdir(),'task-reasoning-native-'))
    const h = await nativeTaskHost(root,async()=>[],{resident:true})
    await t.beginBusiness()

    const cwd = join(root,'tasks','owner'); await t.step(async () => mkdir(cwd,{recursive:true}))
    const manager = createTaskSessions({ctx:h.ctx,isCurrent:async()=>true,getWorkspaceDir:async()=>cwd})
    t.after(async()=>{try{await manager.close();await h.close()}finally{await rm(root,{recursive:true,force:true})}})
    const requests=[], entered=Promise.withResolvers(), release=Promise.withResolvers()
    installModel(h.ctx,['reasoning-test'],async()=>{
      if(requests.length===1){entered.resolve();await release.promise}
      return [decision('wait')]
    },requests)
    const global={provider:'executor',model:'sol',reasoningEffort:'low'}, config={provider:'reasoning-test',model:'astra'}
    const run=leaseEpoch=>manager.run({binding:{kind:'task-session',taskId:'owner',sessionId:'original-owner',leaseEpoch,sessionBound:leaseEpoch>1},
      ...taskModelSelection(global,config),agentPreset:'native-test',input:{task:{title:'原任务',objective:'核对配置'},wakes:[]},
      onSessionBound:async()=>{},submit:async()=>({accepted:true})})
    const first=run(1); await t.step(async () => entered.promise)
    config.reasoningEffort='high';release.resolve();assert.equal((await t.step(async () => first)).status,'submitted')
    assert.equal(requests[0].reasoningEffort,'low','in-flight request keeps its original selection')
    assert.equal((await t.step(async () => run(2))).status,'submitted');assert.equal(requests.at(-1).reasoningEffort,'high')
    config.reasoningEffort=null
    assert.equal((await t.step(async () => run(3))).status,'submitted');assert.equal(requests.at(-1).reasoningEffort,'medium','native adapter model default differs from global low')
    const before=await t.step(async () => inspectSession(h.ctx.sessionPersistence,'original-owner'))
    config.reasoningEffort='ultra'
    await t.step(async () => assert.rejects(run(4),{code:'TASK_SESSION_REASONING_EFFORT_UNSUPPORTED'}))
    assert.deepEqual((await t.step(async () => inspectSession(h.ctx.sessionPersistence,'original-owner'))).events,before.events)
    assert.equal(before.events.filter(x=>x.type==='plugin:dingtalk/task-session').length,1)
    assert.equal(requests.length,3);assert.equal(global.reasoningEffort,'low')
  }))

test('native service sends explicit owner depth while delegated execution and its provider retain the global selection',
  { ...({skip:!available ? reason : false,timeout:30000}), timeout: nativeLifecycleTimeout(30000) },nativeLifecycle(30000, async (t) => {
    const root=await mkdtemp(join(tmpdir(),'task-depth-isolation-')),requests=[]
    let h,delegated=false
    const verification = nativeVerificationTeam()
    t.after(async()=>{try{await h?.close()}finally{await rm(root,{recursive:true,force:true})}})
    await t.beginBusiness()
    h=await t.step(async () => nativeTaskHost(root,async()=>[],{agentConfig:{provider:'executor-test',model:'sol',reasoningEffort:'low',
      taskSessionModel:{provider:'owner-test',model:'astra',reasoningMode:'explicit',reasoningEffort:'high'}},
      serviceFactory:async options=>{
        installModel(options.ctx,['executor-test','owner-test'],async request=>{
          if(request.tools.some(x=>x.name==='task_delegate')){
            const input=latestInput(request), primary=input.executions.find(x=>x.key==='depth-isolation'), done=primary?.status==='succeeded'&&primary.drained
            const review=verification.owner(input,primary); if(review)return review
            const calls=delegated?[]:[{name:'task_delegate',args:{key:'depth-isolation',objective:'独立执行核对'}}]
            delegated=true;return [...calls,decision(done?'complete':'wait')]
          }
          return verification.execute(request,latestInput(request)) ?? [{name:'execution_submit',args:{output:{status:'completed',summary:'已核对',evidence:[],limitations:[],artifacts:[]}}}]
        },requests)
        return openTaskSessionService(options)
      }}))
    const task=await t.step(async () => h.service.createTask({groupId:'native-group',requestId:'depth-isolation',objective:'核对独立推理深度'}))
    await t.step(async () => h.service.whenIdle())
    assert.equal((await t.step(async () => h.query('task.get',{taskId:task.taskId}))).status,'completed',JSON.stringify(h.service.listAlerts()))
    const owners=requests.filter(x=>x.tools.some(t=>t.name==='task_delegate')),executors=requests.filter(x=>x.tools.some(t=>t.name==='execution_submit'))
    assert.ok(owners.length>=2);assert.ok(executors.length)
    assert.ok(owners.every(x=>x.provider==='owner-test'&&x.model==='astra'&&x.reasoningEffort==='high'))
    assert.ok(executors.every(x=>x.provider==='executor-test'&&x.model==='sol'&&x.reasoningEffort==='low'))
  }))
