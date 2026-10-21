import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { available, reason, nativeTaskHost, latestInput, topicSummaryResponse, waitUntil } from './fixtures/task-session-native-host.js'
import { openResidentStore } from '../packages/dingtalk-dsh-assistant/store.js'
import { openTaskResidentRuntime } from '../packages/dingtalk-dsh-assistant/task-resident-runtime.js'
import { openTaskSessionService } from '../packages/dingtalk-dsh-assistant/task-session-service.js'

test('saved coordination selection changes the next native plan only, with original cwd and independent Owner/executor selections',
  {skip:!available?reason:false,timeout:30000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'coordination-model-native-')), requests=[]
    const entered=Promise.withResolvers(),release=Promise.withResolvers();let h,runtime,first=true,delegated=false
    t.after(async()=>{release.resolve();await h?.service?.close();await runtime?.close();await h?.close();await rm(root,{recursive:true,force:true})})
    h=await nativeTaskHost(root,async request=>{
      const names=request.tools.map(x=>x.name),input=latestInput(request)
      if(names.includes('group_topic_route_submit')) return [{name:'group_topic_route_submit',args:{requestId:input.requestId,routes:input.messages.map(m=>({messageId:m.messageId,messageVersion:m.messageVersion,
        ignoredRefs:[],units:[{unitKey:'order',summary:'协调歧义',sourceRefs:[{quote:m.text}],dispatchOwner:'coordination',topics:[],reason:'需核对原任务'}]}))}}]
      if(names.includes('execution_submit'))return [{name:'execution_submit',args:{output:{status:'completed',summary:'已核对',evidence:[],limitations:[],artifacts:[]}}}]
      return []
    },{resident:true})
    const profile=createRequire(pathToFileURL(resolve(process.env.DSH_NATIVE_TEST_PROFILE))), native=createRequire(profile.resolve('@deepseek-ai/dsh-base'))
    const {LlmAdapter}=native('@deepseek-ai/dsh-llm');let sequence=0
    class Controlled extends LlmAdapter {
      resolveModel(provider,model){return {provider,id:model,name:model,reasoning:{efforts:['low','medium','high'].map(id=>({id,name:id})),defaultEffort:'medium'}}}
      async *stream(request){
        if (yield* topicSummaryResponse(request, h.auxiliaryRequests)) return
        requests.push(structuredClone(request));const names=request.tools.map(x=>x.name), input=latestInput(request);let calls=[]
        if(names.includes('group_topic_route_submit'))calls=[{name:'group_topic_route_submit',args:{requestId:input.requestId,routes:input.messages.map(m=>({messageId:m.messageId,messageVersion:m.messageVersion,
          ignoredRefs:[],units:[{unitKey:'order',summary:'协调歧义',sourceRefs:[{quote:m.text}],dispatchOwner:'coordination',topics:[],reason:'需核对原任务'}]}))}}]
        else if(names.includes('coordination_submit')){
          if(first){first=false;entered.resolve();await release.promise}
          calls=[{name:'coordination_submit',args:{kind:'clarify',question:'请明确A和B',candidates:[]}}]
        } else if(names.includes('task_delegate')){
          const done=input.executions.some(e=>e.status==='succeeded'&&e.drained)
          calls=[...(delegated?[]:[{name:'task_delegate',args:{key:'selection-isolation',objective:'验证执行模型独立'}}]),
            {name:'task_session_submit',args:{decision:{action:done?'complete':'wait',summary:'核对原目标',evidence:[],limitations:[]}}}]
          delegated=true
        } else if(names.includes('execution_submit'))calls=[{name:'execution_submit',args:{output:{status:'completed',summary:'已核对',evidence:[],limitations:[],artifacts:[]}}}]
        for(const [index,call]of calls.entries()){
          const id=`coord-model-${++sequence}`,args=JSON.stringify(call.args)
          yield {type:'block-start',index,blockType:'tool-call'}
          yield {type:'tool-call-delta',index,id,name:call.name,argumentsDelta:args}
          yield {type:'block-end',index,block:{type:'tool-call',id,name:call.name,arguments:args}}
        }
        yield {type:'finish',reason:{kind:calls.length?'tool-calls':'stop'}}
      }
    }
    h.ctx.llm.registerAdapter(['coord-test','owner-test'],new Controlled())
    const store=await openResidentStore(h.ctx.storageDomain)
    runtime=await openTaskResidentRuntime(h.ctx,store,root,{agentPreset:'native-test',taskSessionModel:{provider:'owner-test',model:'owner-model',reasoningEffort:'low'},
      coordinationModel:{provider:'coord-test',model:'coord-old',reasoningEffort:'low'}})
    await runtime.subscribe({groupId:'native-group',name:'隔离配置群'})
    h.service=await openTaskSessionService({ctx:h.ctx,legacy:runtime,residentStore:store,
      config:{dbPath:join(root,'dynamic.db'),instanceId:'coord-selection',initialize:true,ownerActorId:'native-user',webActorId:'native-user',coordination:{enabled:true,provider:'coord-test',model:'coord-old',reasoningEffort:'low'}},
      notifications:{async send(){return {messageId:'isolated'}},async readback(){return {visible:true,messageId:'isolated'}}}})
    const ingest=n=>h.service.ingest({groupId:'native-group',messageId:`model-${n}`,senderOpenDingTalkId:'user',text:`A完成之后B：${n}`,timestamp:'2026-10-21T01:00:00Z'})
    const config=runtime.getAgentConfig(), firstIngress=ingest(1)
    try { await waitUntil(()=>!first,'first coordination request',5000) }
    catch(error){throw new Error(JSON.stringify({alerts:h.service.listAlerts(),requests:requests.map(r=>({provider:r.provider,model:r.model,tools:r.tools.map(t=>t.name)})),fallback:h.requests.map(r=>r.tools.map(t=>t.name)),config:runtime.getAgentConfig()}),{cause:error})}
    const inFlight=[...h.ctx.agents.list()].find(a=>a.id.startsWith('independent-'))
    assert.ok(inFlight);assert.equal(inFlight.options.model,'coord-old')
    const next={provider:'coord-test',model:'coord-next',reasoningMode:'explicit',reasoningEffort:'high'}
    await runtime.updateAgentConfig({coordinationModel:next})
    assert.equal(inFlight.options.model,'coord-old');assert.equal(inFlight.options.reasoningEffort,'low')
    release.resolve();await firstIngress;await h.service.whenIdle()
    await ingest(2);await h.service.whenIdle()
    const plans=requests.filter(r=>r.tools.some(t=>t.name==='coordination_submit'))
    assert.deepEqual(plans.map(r=>[r.provider,r.model,r.reasoningEffort]),[['coord-test','coord-old','low'],['coord-test','coord-next','high']])
    await runtime.updateAgentConfig({coordinationModel:{...next,reasoningMode:'model-default',reasoningEffort:null}})
    await ingest(3);await h.service.whenIdle()
    assert.equal(requests.filter(r=>r.tools.some(t=>t.name==='coordination_submit')).at(-1).reasoningEffort,'medium')
    await assert.rejects(runtime.updateAgentConfig({coordinationModel:{...next,reasoningEffort:'ultra'}}))
    assert.deepEqual(runtime.getAgentConfig().taskSessionModel,config.taskSessionModel)
    assert.equal(runtime.getAgentConfig().model,config.model);assert.equal(runtime.getAgentConfig().reasoningEffort,config.reasoningEffort)
    const task=await h.service.createTask({groupId:'native-group',requestId:'selection-isolation',objective:'核对模型边界'})
    await h.service.whenIdle()
    assert.equal((await h.service.store.query({kind:'task.get',taskId:task.taskId})).status,'completed',JSON.stringify(h.service.listAlerts()))
    const owners=requests.filter(r=>r.tools.some(t=>t.name==='task_delegate')),executors=h.requests.filter(r=>r.tools.some(t=>t.name==='execution_submit'))
    assert.ok(owners.length);assert.ok(executors.length)
    assert.ok(owners.every(r=>r.provider==='owner-test'&&r.model==='owner-model'&&r.reasoningEffort==='low'))
    assert.ok(executors.every(r=>r.provider==='native-task-test'&&r.model==='controlled'&&r.reasoningEffort==='low'))
    assert.equal(plans[0].messages.some(m=>m.role==='user'),true)
  })

test('saving a coordination model while admission is disabled cannot create an independent planning session',
  {skip:!available?reason:false,timeout:15000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'coordination-model-disabled-'));let h,runtime,plans=0
    t.after(async()=>{await h?.service?.close();await runtime?.close();await h?.close();await rm(root,{recursive:true,force:true})})
    h=await nativeTaskHost(root,request=>{
      const input=latestInput(request)
      if(request.tools.some(t=>t.name==='group_topic_route_submit'))return [{name:'group_topic_route_submit',args:{requestId:input.requestId,
        routes:input.messages.map(m=>({messageId:m.messageId,messageVersion:m.messageVersion,ignoredRefs:[{quote:m.text,reason:'协调新接纳关闭，仅保留讨论'}],units:[]}))}}]
      return []
    },{resident:true})
    h.ctx.on('session/created',session=>{if(session.id.startsWith('independent-'))plans++})
    const store=await openResidentStore(h.ctx.storageDomain)
    runtime=await openTaskResidentRuntime(h.ctx,store,root,{agentPreset:'native-test'})
    await runtime.subscribe({groupId:'native-group',name:'隔离配置群'})
    h.service=await openTaskSessionService({ctx:h.ctx,legacy:runtime,residentStore:store,
      config:{dbPath:join(root,'disabled.db'),instanceId:'coord-disabled',initialize:true,coordination:{enabled:false}},
      notifications:{async send(){return {messageId:'isolated'}},async readback(){return {visible:true,messageId:'isolated'}}}})
    const coordinationModel={provider:'native-task-test',model:'configured-but-disabled',reasoningMode:'explicit',reasoningEffort:'low'}
    await runtime.updateAgentConfig({coordinationModel})
    await h.service.ingest({groupId:'native-group',messageId:'disabled',senderOpenDingTalkId:'user',text:'A完成后继续B',timestamp:'2026-10-21T01:00:00Z'})
    await h.service.whenIdle()
    assert.deepEqual(runtime.getAgentConfig().coordinationModel,coordinationModel)
    assert.equal(plans,0);assert.equal(store.listSourceDispatchOwnership('native-group').length,0)
    assert.ok(h.requests.some(request=>JSON.stringify(request).includes('独立任务协调的新接纳已关闭')))
    assert.equal((await h.service.store.query({kind:'task.list'})).length,0)
  })
