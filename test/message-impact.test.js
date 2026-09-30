import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'message-impact-')),dbPath=join(directory,'control.sqlite'),instanceId=randomUUID()
  let store=await openExecutionStore({dbPath,instanceId,initialize:true})
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true})})
  const f={directory,dbPath,instanceId,get store(){return store},
    call:(kind,args)=>store.command({id:randomUUID(),kind:kind.startsWith('message.')?kind:'message.'+kind,args}),
    reopen:async()=>{await store.close();store=await openExecutionStore({dbPath,instanceId})}}
  f.receive=(id,extra={})=>f.call('receive',{runId:id,sourceKey:id,sourceVersion:1,conversationId:'group',actorId:'actor',body:'来源 '+id,...extra})
  f.bind=async(id,topicId,unitId=id+'-unit')=>{
    await f.call('topic.bind',{runId:id,unitId,expectedRevision:0,binding:{type:'topic'},topic:{topicId,conversationId:'group',sourceRunId:id,unitId,title:topicId,facts:[]}})
  }
  f.topic=async(id,topicId)=>{await f.receive(id);await f.call('split',{runId:id,units:[{unitId:id+'-unit'}]});await f.bind(id,topicId)}
  f.prove=async(id,topicId,unitId='$')=>{
    const catalog=await store.query({kind:'message.impact',runId:id}),source=(await store.query({kind:'message.run',runId:id})).run
    return f.call('impact.resolve',{runId:id,expectedRevision:source.revision,unitId,catalogRevision:catalog.catalogRevision,
      assessments:[{topicId,relation:'independent',reason:'核对对象与目标不同',sourceRefs:[{sourceKey:id,sourceVersion:source.sourceVersion,text:source.body}]}]})
  }
  f.pending=topicId=>store.query({kind:'message.routing.pending',conversationId:'group',topicId})
  return f
}
const rejects=(promise,code)=>assert.rejects(promise,error=>error.code===code)

test('A15/A18 未知保守阻挡；有来源证明的独立 B 真正领取并完成命令，A仍等待',async t=>{
  const f=await fixture(t);await f.topic('b','topic-b');await f.receive('a')
  await f.call('wait',{runId:'a',nodeId:'S',reason:'缺业务信息',request:{requestId:'qa',kind:'needs_clarification'}})
  assert.equal((await f.pending('topic-b')).length,1)
  await f.prove('a','topic-b')
  assert.deepEqual(await f.pending('topic-b'),[])
  const topic=await f.store.query({kind:'message.topic',topicId:'topic-b'})
  await f.call('topic.intent.accept',{runId:'b',topicId:'topic-b',conversationId:'group',inputRevision:topic.inputRevision,
    decisions:[{unitId:'b-unit',expectedRevision:0,commands:[{commandId:'b-answer',kind:'answer',args:{}}]}]})
  const claimed=await f.call('command.claim',{commandId:'b-answer'});assert.equal(claimed.dispatchEligible,true)
  await f.call('command.complete',{commandId:'b-answer',leaseEpoch:claimed.result.command.leaseEpoch,result:{reply:'B 已核查完成'}})
  assert.equal((await f.store.query({kind:'message.command',commandId:'b-answer'})).result.reply,'B 已核查完成')
  assert.equal((await f.store.query({kind:'message.request',requestId:'qa'})).status,'pending')
})

test('A16/A27 排除证明绑定目标与来源版本，新事实/目录变更不能套用旧证明',async t=>{
  const f=await fixture(t);await f.topic('b','topic-b');await f.receive('unknown');await f.prove('unknown','topic-b')
  const catalog=await f.store.query({kind:'message.impact',runId:'unknown'})
  await f.topic('supplement','topic-b')
  assert.equal((await f.pending('topic-b')).length,1)
  await rejects(f.call('impact.resolve',{runId:'unknown',catalogRevision:catalog.catalogRevision,assessments:[]}), 'MESSAGE_IMPACT_CATALOG_STALE')
  await f.prove('unknown','topic-b');await f.reopen();assert.deepEqual(await f.pending('topic-b'),[])
  await f.receive('unknown-v2',{sourceKey:'unknown',sourceVersion:2,body:'改变范围'})
  assert.equal((await f.pending('topic-b')).length,1)
})

test('A17/A26 无执行权的精确引用补充仍在 command claim 事务阻止旧效果',async t=>{
  const f=await fixture(t);await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await f.receive('fact',{actorId:'unprivileged',context:{quoteRefs:[{sourceKey:'origin'}]}})
  await rejects(f.call('command.claim',{commandId:'c'}),'MESSAGE_INPUT_PENDING')
  assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'pending')
})

test('A18 引用A并额外指代B的混合消息不能凭引用排除B',async t=>{
  const f=await fixture(t);await f.topic('a','topic-a');await f.topic('b','topic-b')
  await f.receive('mixed',{body:'这个A先保留，同时取消其他所有任务',context:{quoteRefs:[{sourceKey:'a'}]}})
  assert.equal((await f.pending('topic-a')).length,1)
  assert.equal((await f.pending('topic-b')).length,1)
})

test('A20 同消息多事项按完整覆盖后的 unit 证明推进，父等待不会阻断已绑定事项',async t=>{
  const f=await fixture(t);await f.receive('multi');await f.call('split',{runId:'multi',units:[{unitId:'ready'},{unitId:'waiting'}]})
  await f.bind('multi','topic-ready','ready')
  await f.call('wait',{runId:'multi',unitId:'waiting',nodeId:'R',reason:'等待材料',request:{requestId:'q',kind:'needs_context'}})
  assert.equal((await f.pending('topic-ready')).length,1)
  await f.prove('multi','topic-ready','waiting');assert.deepEqual(await f.pending('topic-ready'),[])
  await f.call('attention',{runId:'multi',unitId:'waiting',reason:'waiting material'})
  const claimed=await f.call('node.claim',{runId:'multi',unitId:'ready',nodeId:'IB',input:{topicId:'topic-ready'},estimatedInputTokens:1,maxOutputTokens:1})
  assert.equal(claimed.result.node.status,'running')
})

test('A21 内部请求有界重试和同ID恢复，非法协议受管supersede保留审计',async t=>{
  const f=await fixture(t);await f.receive('a')
  await f.call('wait',{runId:'a',nodeId:'R',reason:'资源不可用',request:{requestId:'q',kind:'needs_context'}})
  for(let i=0;i<3;i++)await f.call('request.retry',{runId:'a',requestId:'q',error:'unavailable',retryAt:null,maxAttempts:3,contractVersion:'material-v2'})
  await f.reopen();const q=await f.store.query({kind:'message.request',requestId:'q'})
  assert.equal(q.attempts,3);assert.equal(q.blocked,true);assert.equal(q.responsibility,'system')
  await f.call('request.supersede',{runId:'a',requestId:'q',reason:'invalid internal reference'})
  assert.equal((await f.store.query({kind:'message.request',requestId:'q'})).status,'superseded')
  assert.equal((await f.store.query({kind:'message.run',runId:'a'})).run.status,'pending')
})

test('A20 局部R协议失败不挡另一未绑定unit的R领取，共享$失败仍挡全部',async t=>{
  const f=await fixture(t);await f.receive('multi');await f.call('split',{runId:'multi',units:[{unitId:'a'},{unitId:'b'}]})
  await f.call('attention',{runId:'multi',unitId:'a',reason:'MESSAGE_INVALID_CONTEXT_RESOURCE'})
  await rejects(f.call('node.claim',{runId:'multi',unitId:'a',nodeId:'R',input:{}}),'MESSAGE_NEEDS_ATTENTION')
  assert.equal((await f.call('node.claim',{runId:'multi',unitId:'b',nodeId:'R',input:{}})).result.node.status,'running')
  await f.reopen()
  const state=await f.store.query({kind:'message.run',runId:'multi'})
  assert.equal(state.units.find(unit=>unit.id==='a').blockedReason,'MESSAGE_INVALID_CONTEXT_RESOURCE')
  assert.equal(state.run.attentionScope,'unit')
  await f.call('attention',{runId:'multi',unitId:'$',reason:'共享条件尚未完整'})
  await rejects(f.call('node.claim',{runId:'multi',unitId:'b',nodeId:'R',input:{}}),'MESSAGE_NEEDS_ATTENTION')
})

test('A20 已绑定局部失败只阻挡相关topic，独立topic保留推进资格',async t=>{
  const f=await fixture(t);await f.topic('a','topic-a');await f.topic('b','topic-b')
  await f.call('attention',{runId:'a',unitId:'a-unit',reason:'I protocol failed'})
  assert.equal((await f.pending('topic-a')).length,1)
  assert.deepEqual(await f.pending('topic-b'),[])
  assert.deepEqual(await f.store.query({kind:'message.topic.units',topicId:'topic-a'}),[])
  assert.equal((await f.store.query({kind:'message.topic.units',topicId:'topic-b'})).length,1)
})

test('受管reprocess新版本登记impact并清除旧局部失败聚合，原审计保留',async t=>{
  const f=await fixture(t);await f.receive('old');await f.call('split',{runId:'old',units:[{unitId:'u'}]})
  await f.call('attention',{runId:'old',unitId:'u',reason:'协议错误'})
  await f.call('reprocess',{runId:'old',newRunId:'next',reason:'repair',policy:{initialWindowMs:90000,linkedWindowMs:90000,maxClaims:99999}})
  const next=(await f.store.query({kind:'message.run',runId:'next'})).run
  assert.equal(next.sourceVersion,2);assert.equal(next.attentionScope,undefined);assert.equal(next.attentionUnitIds,undefined)
  assert.equal(Date.parse(next.deadline)-Date.parse(next.createdAt),90000);assert.equal(next.policy.linkedWindowMs,90000);assert.equal(next.policy.maxClaims,21)
  assert.equal((await f.store.query({kind:'message.impact',runId:'next'})).impact.sourceVersion,2)
  assert.equal((await f.store.query({kind:'message.run',runId:'old'})).units[0].blockedReason,'协议错误')
})

test('A17 新输入分别在 node claim 与 effect begin 阻止已准备的旧动作',async t=>{
  const f=await fixture(t);await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  const command=(kind,args)=>f.store.command({id:randomUUID(),kind,args}),hash='a'.repeat(64)
  await command('run.create',{runId:'execution',taskId:'task',workflowId:'w',workflowDigest:hash,requirementRef:'sha256/in',
    nodes:[{nodeId:'node',nodeVersion:'1',executor:'code',inputRef:'sha256/in',inputDigest:hash}]})
  await f.receive('before-node',{context:{quoteRefs:[{sourceKey:'origin'}]}})
  await rejects(command('node.claim',{runId:'execution',nodeId:'node',expectedGeneration:1,expectedLeaseEpoch:0}),'MESSAGE_INPUT_PENDING')
  await f.prove('before-node','topic-a')
  const binding=(await command('node.claim',{runId:'execution',nodeId:'node',expectedGeneration:1,expectedLeaseEpoch:0})).result.binding
  await command('effect.prepare',{effectId:'effect',kind:'operation',runId:'execution',nodeId:'node',generation:binding.generation,
    leaseEpoch:binding.leaseEpoch,inputDigest:hash,definition:{adapterId:'synthetic',adapterVersion:'1',principalId:'actor',target:'database',args:{write:1}},
    resourceKeys:['database:x'],authorizationRef:'test-grant'})
  await f.receive('before-effect',{actorId:'other',context:{quoteRefs:[{sourceKey:'origin'}]}})
  await rejects(command('effect.begin',{effectId:'effect',leaseEpoch:binding.leaseEpoch,expectedSafetyEpoch:0}),'MESSAGE_INPUT_PENDING')
  assert.equal((await f.store.query({kind:'effect.get',effectId:'effect'})).state,'prepared')
})

test('A23 task.accept同事务持久承接责任，command未完成及重启也可准备真实承接通知',async t=>{
  const f=await fixture(t);await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await f.call('command.claim',{commandId:'c'})
  await f.store.command({id:randomUUID(),kind:'task.accept',args:{taskId:'task',requirementRef:'sha256/requirement',requirementRevision:1,
    sessionId:'session',criteria:['完成原始目标'],sourceKey:'origin',eventKey:'created'}})
  await f.reopen();assert.equal((await f.store.query({kind:'message.command',commandId:'c'})).status,'unknown')
  const [fact]=await f.store.query({kind:'message.acceptances',runId:'origin'});assert.equal(fact.taskId,'task')
  await f.call('notification.prepare',{runId:'origin',notificationId:'ack',acceptanceId:fact.id,eventKey:'task.accepted:task:1',
    payload:{text:'已接纳，尚未开始',conversationId:'group'},disclosure:{conversationId:'group',authorizationRef:'origin'}})
  assert.equal((await f.call('notification.claim',{notificationId:'ack'})).dispatchEligible,true)
})

test('A17 Owner候选接纳、应用、计划接纳和阶段启动均在同库事务复查输入',async t=>{
  const f=await fixture(t),command=(kind,args)=>f.store.command({id:randomUUID(),kind,args}),hash='a'.repeat(64)
  await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await command('task.accept',{taskId:'task',requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'session',criteria:['核查'],sourceKey:'origin',eventKey:'created'})
  await command('task.owner.claim',{taskId:'task',turnId:'turn',expectedLeaseEpoch:0})
  await command('task.owner.sessionBound',{taskId:'task',turnId:'turn',leaseEpoch:1,sessionId:'session'})
  await command('task.owner.candidate',{taskId:'task',turnId:'turn',leaseEpoch:1,decision:{action:'wait',summary:'准备材料',evidenceRefs:[]}})
  await f.receive('before-owner')
  await rejects(command('task.owner.accept',{taskId:'task',turnId:'turn',leaseEpoch:1}),'MESSAGE_INPUT_PENDING')
  await f.prove('before-owner','topic-a')
  await command('task.owner.accept',{taskId:'task',turnId:'turn',leaseEpoch:1})
  await f.receive('before-apply')
  await rejects(command('task.owner.applied',{taskId:'task',turnId:'turn',leaseEpoch:1}),'MESSAGE_INPUT_PENDING')
  await f.prove('before-apply','topic-a');await command('task.owner.applied',{taskId:'task',turnId:'turn',leaseEpoch:1})
  const plan={taskId:'task',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,
    stages:[{stageId:'stage',workflowId:'work',workflowDigest:hash,unavailableReason:null,requirementRef:'sha256/requirement',gate:'none'}]}
  await f.receive('before-plan');await rejects(command('task.plan.initialize',plan),'MESSAGE_INPUT_PENDING')
  await f.prove('before-plan','topic-a');await command('task.plan.initialize',plan)
  const run={runId:'execution',taskId:'task',workflowId:'work',workflowDigest:hash,requirementRef:'sha256/requirement',
    stageBinding:{planRevision:1,stageId:'stage',attempt:1,expectedControlRevision:1},
    nodes:[{nodeId:'node',nodeVersion:'1',executor:'code',inputRef:'sha256/in',inputDigest:hash}]}
  await f.receive('before-stage');await rejects(command('run.create',run),'MESSAGE_INPUT_PENDING')
  await f.prove('before-stage','topic-a');assert.equal((await command('run.create',run)).result.run.status,'queued')
})

test('A16/A26 已归类相关事实令旧Owner候选失效，当前Owner应用前不领取阶段',async t=>{
  const f=await fixture(t),command=(kind,args)=>f.store.command({id:randomUUID(),kind,args}),hash='a'.repeat(64)
  await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await command('task.accept',{taskId:'task',requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'session',criteria:['核查'],sourceKey:'origin',eventKey:'created'})
  await command('task.owner.claim',{taskId:'task',turnId:'old',expectedLeaseEpoch:0})
  await command('task.owner.sessionBound',{taskId:'task',turnId:'old',leaseEpoch:1,sessionId:'session'})
  await command('task.owner.candidate',{taskId:'task',turnId:'old',leaseEpoch:1,decision:{action:'wait',summary:'旧候选',evidenceRefs:[]}})
  await f.receive('fact',{actorId:'unprivileged',body:'追加不能改变行业审核状态'})
  await f.call('split',{runId:'fact',units:[{unitId:'fact-unit'}]});await f.bind('fact','topic-a')
  await f.call('topic.intent.accept',{runId:'fact',topicId:'topic-a',conversationId:'group',inputRevision:2,
    decisions:[{unitId:'fact-unit',expectedRevision:0,commands:[],outcome:'ignored'}]})
  await rejects(command('task.owner.accept',{taskId:'task',turnId:'old',leaseEpoch:1}),'TASK_OWNER_CANDIDATE_STALE')
  const sources=await f.store.query({kind:'message.task.inputs',taskId:'task'})
  assert.equal(sources.find(source=>source.sourceKey==='fact').actorId,'unprivileged')
  await command('task.owner.release',{taskId:'task',turnId:'old',leaseEpoch:1,reason:'TASK_OWNER_CANDIDATE_STALE'})
  await command('task.owner.claim',{taskId:'task',turnId:'current',expectedLeaseEpoch:1})
  await command('task.owner.candidate',{taskId:'task',turnId:'current',leaseEpoch:2,decision:{action:'wait',summary:'已纳入事实核对',evidenceRefs:[]}})
  await command('task.owner.accept',{taskId:'task',turnId:'current',leaseEpoch:2})
  await command('task.plan.initialize',{taskId:'task',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,
    stages:[{stageId:'stage',workflowId:'work',workflowDigest:hash,unavailableReason:null,requirementRef:'sha256/requirement',gate:'none'}]})
  const run={runId:'execution',taskId:'task',workflowId:'work',workflowDigest:hash,requirementRef:'sha256/requirement',
    stageBinding:{planRevision:1,stageId:'stage',attempt:1,expectedControlRevision:1},
    nodes:[{nodeId:'node',nodeVersion:'1',executor:'code',inputRef:'sha256/in',inputDigest:hash}]}
  await rejects(command('run.create',run),'MESSAGE_INPUT_PENDING')
  await command('task.owner.applied',{taskId:'task',turnId:'current',leaseEpoch:2})
  assert.equal((await command('run.create',run)).result.run.status,'queued')
})

test('可信消费信封仅豁免自身已领取输入，其他新输入和真实效果领取不能绕过',async t=>{
  const f=await fixture(t),command=(kind,args,extra={})=>f.store.command({id:randomUUID(),kind,args,...extra}),hash='a'.repeat(64)
  await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await command('task.accept',{taskId:'task',requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'session',criteria:['核查'],sourceKey:'origin',eventKey:'created'})
  await f.receive('control',{barriers:[{barrierId:'own-fence',targetTaskId:'task'}]})
  await f.call('split',{runId:'control',units:[{unitId:'control-unit'}]});await f.bind('control','topic-a')
  await f.call('topic.intent.accept',{runId:'control',topicId:'topic-a',conversationId:'group',inputRevision:2,
    decisions:[{unitId:'control-unit',expectedRevision:0,commands:[{commandId:'reopen',kind:'reopen',args:{taskId:'task'}}]}]})
  const plan={taskId:'task',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,
    stages:[{stageId:'stage',workflowId:'work',workflowDigest:hash,unavailableReason:null,requirementRef:'sha256/requirement',gate:'none'}]}
  await rejects(command('task.plan.initialize',plan,{inputCommandId:'reopen'}),'MESSAGE_INPUT_CONSUMPTION_INVALID')
  await f.call('command.claim',{commandId:'reopen'})
  await rejects(command('task.plan.initialize',plan),'MESSAGE_INPUT_PENDING')
  assert.equal((await command('task.plan.initialize',plan,{inputCommandId:'reopen'})).result.status,'applied')
  await rejects(command('effect.begin',{effectId:'effect',leaseEpoch:1,expectedSafetyEpoch:0},{inputCommandId:'reopen'}),'MESSAGE_INPUT_CONSUMPTION_FORBIDDEN')
  await rejects(command('node.claim',{runId:'execution',nodeId:'node',expectedGeneration:1,expectedLeaseEpoch:0},{ownerTurnId:'turn'}),'MESSAGE_INPUT_CONSUMPTION_FORBIDDEN')
  await rejects(command('task.plan.initialize',{...plan,taskId:'different-task'},{inputCommandId:'reopen'}),'MESSAGE_INPUT_CONSUMPTION_INVALID')
  await f.receive('other',{barriers:[{barrierId:'other-fence',targetTaskId:'task'}]})
  await rejects(command('task.plan.revise',{taskId:'task'},{inputCommandId:'reopen'}),'MESSAGE_INPUT_PENDING')
})

test('Owner消费信封拒绝旧turn，即使没有新增事实也不能借旧决定准备阶段',async t=>{
  const f=await fixture(t),command=(kind,args,extra={})=>f.store.command({id:randomUUID(),kind,args,...extra})
  await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await command('task.accept',{taskId:'task',requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'session',criteria:['核查'],sourceKey:'origin',eventKey:'created'})
  await command('task.owner.claim',{taskId:'task',turnId:'old',expectedLeaseEpoch:0})
  await command('task.owner.sessionBound',{taskId:'task',turnId:'old',leaseEpoch:1,sessionId:'session'})
  await command('task.owner.candidate',{taskId:'task',turnId:'old',leaseEpoch:1,decision:{action:'wait',summary:'等待阶段',evidenceRefs:[]}})
  await command('task.owner.accept',{taskId:'task',turnId:'old',leaseEpoch:1})
  await command('task.owner.applied',{taskId:'task',turnId:'old',leaseEpoch:1})
  await command('task.owner.event',{taskId:'task',eventKey:'progress',eventType:'stage.progress'})
  await command('task.owner.claim',{taskId:'task',turnId:'new',expectedLeaseEpoch:1})
  await rejects(command('task.plan.initialize',{taskId:'task'},{ownerTurnId:'old'}),'TASK_OWNER_CANDIDATE_STALE')
})

for(const nodeCount of [1,2])test(`A17 已领取节点遇新消息仍排空真实效果和旧结果，${nodeCount===1?'阶段完成':'后继节点'}继续受阻`,async t=>{
  const f=await fixture(t),command=(kind,args)=>f.store.command({id:randomUUID(),kind,args}),hash='a'.repeat(64)
  await f.topic('origin','topic-a')
  await f.call('topic.intent.accept',{runId:'origin',topicId:'topic-a',conversationId:'group',inputRevision:1,
    decisions:[{unitId:'origin-unit',expectedRevision:0,commands:[{commandId:'c',kind:'create',args:{taskId:'task'}}]}]})
  await command('task.accept',{taskId:'task',requirementRef:'sha256/requirement',requirementRevision:1,sessionId:'session',criteria:['核查'],sourceKey:'origin',eventKey:'created'})
  await command('task.plan.initialize',{taskId:'task',expectedPlanRevision:0,expectedRequirementRevision:1,expectedControlRevision:1,
    stages:[{stageId:'stage',workflowId:'work',workflowDigest:hash,unavailableReason:null,requirementRef:'sha256/requirement',gate:'none'}]})
  await command('run.create',{runId:'execution',taskId:'task',workflowId:'work',workflowDigest:hash,requirementRef:'sha256/requirement',
    stageBinding:{planRevision:1,stageId:'stage',attempt:1,expectedControlRevision:1},
    nodes:Array.from({length:nodeCount},(_,i)=>({nodeId:'node'+i,nodeVersion:'1',executor:'code',inputRef:i?null:'sha256/in',inputDigest:i?null:hash}))})
  await command('node.claim',{runId:'execution',nodeId:'node0',expectedGeneration:1,expectedLeaseEpoch:0})
  const effect={effectId:'effect',kind:'operation',runId:'execution',nodeId:'node0',generation:1,leaseEpoch:1,inputDigest:hash,
    definition:{adapterId:'synthetic',adapterVersion:'1',principalId:'actor',target:'database',args:{write:1}},resourceKeys:['database:x'],authorizationRef:'test-grant'}
  await command('effect.prepare',effect)
  assert.equal((await command('effect.begin',{effectId:'effect',leaseEpoch:1,expectedSafetyEpoch:0})).dispatchEligible,true)
  await f.receive('new-input',{body:'先别继续，需要核对新的事实'})
  await command('effect.observe',{effectId:'effect',receiptId:'observed-once',status:'succeeded',evidenceRef:'sha256/observation',result:{actualWrites:1}})
  await command('node.drained',{runId:'execution',nodeId:'node0',generation:1,leaseEpoch:1,evidenceRef:'sha256/drained'})
  const committed=await command('node.commit',{runId:'execution',nodeId:'node0',generation:1,leaseEpoch:1,inputDigest:hash,outcome:'succeeded',
    outputRef:'sha256/result',evidenceRefs:['sha256/observation'],...(nodeCount===2?{nextInput:{nodeId:'node1',inputRef:'sha256/next',inputDigest:hash}}:{})})
  assert.equal(committed.result.status,'applied')
  if(nodeCount===2)await rejects(command('node.claim',{runId:'execution',nodeId:'node1',expectedGeneration:1,expectedLeaseEpoch:0}),'MESSAGE_INPUT_PENDING')
  else await rejects(command('task.stage.complete',{taskId:'task',planRevision:1,stageId:'stage',runId:'execution'}),'MESSAGE_INPUT_PENDING')
  const effects=await f.store.query({kind:'effect.list',runId:'execution'})
  assert.equal(effects.length,1);assert.equal(effects[0].state,'succeeded')
  assert.equal((await f.store.query({kind:'run',runId:'execution'})).nodes[0].outputRef,'sha256/result')
})

test('A28 v5→v6检查零写，迁移保留原账，独占锁防在线旧进程，重试不重放',async t=>{
  const f=await fixture(t);await f.receive('old');await f.store.close()
  const db=new DatabaseSync(f.dbPath)
  db.exec("DELETE FROM message_items WHERE kind='impact'; PRAGMA user_version=5; UPDATE execution_meta SET schema_version=5")
  const original=db.prepare('SELECT body FROM message_runs').get().body;db.close()
  const script=resolve('scripts/migrate-message-impact.js'),hash=async()=>createHash('sha256').update(await readFile(f.dbPath)).digest('hex')
  const before=await hash(),files=await readdir(f.directory)
  const check=JSON.parse(execFileSync(process.execPath,[script,'--check',f.dbPath],{encoding:'utf8'}))
  assert.equal(check.writable,false);assert.equal(await hash(),before);assert.deepEqual(await readdir(f.directory),files)
  const lock=new DatabaseSync(f.dbPath+'.owner.sqlite');lock.exec('BEGIN EXCLUSIVE')
  assert.throws(()=>execFileSync(process.execPath,[script,'--execute',f.dbPath],{stdio:'pipe'}));lock.exec('ROLLBACK');lock.close()
  assert.equal(await hash(),before)
  const stagedCode=`import {DatabaseSync} from 'node:sqlite';
    import {registerMessageImpact} from ${JSON.stringify(pathToFileURL(resolve('packages/dingtalk-dsh-assistant/message-ledger.js')).href)};
    const db=new DatabaseSync(${JSON.stringify(f.dbPath)});db.exec('BEGIN IMMEDIATE');
    for(const row of db.prepare('SELECT body FROM message_runs').all())registerMessageImpact(db,JSON.parse(row.body),new Date().toISOString());
    db.exec('PRAGMA user_version=6;UPDATE execution_meta SET schema_version=6');process.send('staged');setInterval(()=>{},1000);`
  const interrupted=spawn(process.execPath,['--input-type=module','-e',stagedCode],{stdio:['ignore','ignore','pipe','ipc']})
  await new Promise((resolve,reject)=>{interrupted.once('message',resolve);interrupted.once('error',reject);interrupted.once('exit',code=>reject(new Error('migration child exited '+code)))})
  const ended=new Promise(resolve=>interrupted.once('exit',resolve));interrupted.kill();await ended
  const recovered=new DatabaseSync(f.dbPath)
  assert.equal(recovered.prepare('PRAGMA user_version').get().user_version,5)
  assert.equal(recovered.prepare("SELECT COUNT(*) n FROM message_items WHERE kind='impact'").get().n,0);recovered.close()
  const migrated=JSON.parse(execFileSync(process.execPath,[script,'--execute',f.dbPath],{encoding:'utf8'}));assert.equal(migrated.verified,true)
  const raw=new DatabaseSync(f.dbPath,{readOnly:true});assert.equal(raw.prepare('SELECT body FROM message_runs').get().body,original)
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM message_items WHERE kind='impact'").get().n,1)
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,6);raw.close()
  assert.equal(JSON.parse(execFileSync(process.execPath,[script,'--execute',f.dbPath],{encoding:'utf8'})).status,'already-migrated')
  const damaged=new DatabaseSync(f.dbPath)
  const impactRow=damaged.prepare("SELECT * FROM message_items WHERE kind='impact'").get()
  damaged.prepare('DELETE FROM message_items WHERE item_id=?').run(impactRow.item_id);damaged.close()
  for(const mode of ['--check','--execute'])assert.throws(()=>execFileSync(process.execPath,[script,mode,f.dbPath],{stdio:'pipe'}),/MIGRATION_IMPACT_MISSING/)
  const restored=new DatabaseSync(f.dbPath)
  const columns=Object.keys(impactRow)
  restored.prepare(`INSERT INTO message_items (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(impactRow));restored.close()
  const oldSource=execFileSync('git',['show','0ed1f0a:packages/dingtalk-dsh-assistant/execution-store-worker.js'],{encoding:'utf8'})
    .replace(/from '(\.\/[^']+)'/gu,(_,specifier)=>'from '+JSON.stringify(pathToFileURL(resolve('packages/dingtalk-dsh-assistant',specifier)).href))
  const oldWorker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(oldSource)),{workerData:{dbPath:f.dbPath,instanceId:f.instanceId,initialize:false,processIncarnation:'old-v5'}})
  const oldResult=await new Promise((resolve,reject)=>{oldWorker.once('message',resolve);oldWorker.once('error',reject)})
  assert.equal(oldResult.type,'fatal');assert.equal(oldResult.error.code,'STORE_SCHEMA_MISMATCH');await oldWorker.terminate()
  await f.reopen();assert.equal((await f.store.query({kind:'message.run',runId:'old'})).commands.length,0)
})

test('完整材料超过64KiB仍原样持久化并校验同ref冲突',async t=>{
  const f=await fixture(t);await f.receive('large-material')
  const material={text:'完整附件内容'.repeat(20000),contentHash:'original-hash',source:{fileId:'file-large'}}
  await f.call('material.record',{runId:'large-material',resourceRef:'file-large',material})
  await f.reopen()
  assert.deepEqual(await f.store.query({kind:'message.material',runId:'large-material',resourceRef:'file-large'}),material)
  await rejects(f.call('material.record',{runId:'large-material',resourceRef:'file-large',material:{...material,text:material.text+'changed'}}),'MESSAGE_MATERIAL_CONFLICT')
})


test('同文来源别名仍登记影响账，schema6完整性回读通过且不产生业务命令', async t => {
  const f = await fixture(t)
  await f.receive('alias-source')
  await f.call('source.alias', { sourceKey: 'alias-source', sourceVersion: 2, runId: 'alias-version-2', body: '来源 alias-source', actorId: 'actor', conversationId: 'group' })
  const impact = await f.store.query({ kind: 'message.impact', runId: 'alias-version-2' })
  assert.equal(impact.impact.sourceVersion, 2)
  assert.equal((await f.store.query({ kind: 'message.run', runId: 'alias-version-2' })).commands.length, 0)
  await f.reopen()
  const { verifyMessageImpact } = await import('../scripts/migrate-message-impact.js')
  const db = new DatabaseSync(f.dbPath, { readOnly: true })
  try { assert.equal(verifyMessageImpact(db).sources, 2) } finally { db.close() }
})
