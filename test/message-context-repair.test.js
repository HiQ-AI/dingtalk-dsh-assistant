import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { messageSystem, prepareMessageRequest } from '../packages/dingtalk-dsh-assistant/message-model.js'
import { prepareMessageContext, splitContext, unitContext, validateContextRequests, validateExecutionMaterialRefs, messageSchemas } from '../packages/dingtalk-dsh-assistant/message-context.js'
import { messageTimestamp, normalizeHistoryMessage } from '../packages/dingtalk-dsh-assistant/dws-bridge.js'
import { isDirectedTaskRequest } from '../packages/dingtalk-dsh-assistant/workflow-service.js'

test('完整信封只计量字节，长背景与全部原文条件不再被固定上限删减', () => {
  const input = { source: { text: '先执行两条，找我验证通过，再刷69条；不新增派单，不发业务通知。' },
    quotes: [{ sourceKey: 'old', text: '行业专家保留。先写脚本，然后由小鹏审批。'.repeat(100) }],
    background: [{ sourceKey: 'h1', text: '历史原文'.repeat(4000) }], omissions: [] }
  const before = structuredClone(input)
  const prepared = prepareMessageRequest('S', input)
  assert.ok(prepared.inputBytes > 8000)
  assert.deepEqual(input, before)
  assert.ok(JSON.stringify(prepared.messages).includes(input.background[0].text))
  assert.ok(JSON.stringify(prepared.messages).includes(input.quotes[0].text))
})

test('数值、本地北京时间及ISO在不同时区仍比较同一个epoch', () => {
  const earlier = messageTimestamp('2026-09-30 17:15:14')
  assert.equal(earlier, messageTimestamp('2026-09-30T09:15:14Z'))
  assert.equal(messageTimestamp('2026-09-30T17:49:43.607+08:00'), 1790761783607)
  assert.ok(1790761783607 > earlier)
  const history = normalizeHistoryMessage({ messageId: 'm', createTime: '2026-09-30 17:15:14', text: '[文件] 审核.xlsx fileId: exact' }, 'group')
  assert.equal(history.occurredAt, '2026-09-30T09:15:14.000Z')
  assert.equal(history.rawOccurredAt, '2026-09-30 17:15:14')
  assert.deepEqual(history.resourceRefs, [{ type: 'fileId', resourceId: 'exact', name: '审核.xlsx' }])
})

test('S保留点名回应责任，附件从已核验历史和引用进入真实材料键', async () => {
  const run = { sourceKey: 'now', sourceVersion: 1, body: '小小鹏你在嘛，帮忙看第一个sheet', actorId: 'a', conversationId: 'g', context: { directedToAgent: true, quoteRefs: [{ sourceKey: 'file' }] } }
  const snapshot = await prepareMessageContext(run, { history: async () => [{ sourceKey: 'file', sourceVersion: 1, text: '表格', attachments: [{ resourceRef: 'fileId' }] }], splitBackground: async ({ history }) => history, localQuote: async () => ({ sourceKey: 'file', text: '表格', attachments: [{ resourceRef: 'fileId' }] }) })
  assert.equal(splitContext(snapshot).replyObligation.required, true)
  const unit = { spans: [{ start: 0, end: run.body.length }], goalText: run.body, constraints: [], contextNeeds: [] }
  assert.ok(unitContext(snapshot, unit).executionMaterialRefs.includes('fileId'))
  assert.doesNotThrow(() => validateContextRequests('S', { kind: 'needs_context', needs: [{ resourceRef: 'fileId' }] }, splitContext(snapshot)))
})

test('S/R拒绝模型虚构资源但合法Host分页可以继续', () => {
  for (const stage of ['S', 'R']) assert.throws(() => validateContextRequests(stage, { kind: 'needs_context', needs: [{ resourceRef: 'candidate-catalog:invented:page:1' }] }, { candidates: [] }), /MESSAGE_CONTEXT_RESOURCE_REF_INVALID/)
  const output = messageSchemas.R.parse({ kind: 'continue_candidates', reason: '仍有候选', evidence: ['已看本页'] })
  assert.throws(() => validateContextRequests('R', output, {}), /CONTINUATION_UNAVAILABLE/)
  assert.doesNotThrow(() => validateContextRequests('R', output, { candidateContinuation: { catalogRevision: 'v', nextPage: 1 } }))
})

test('事项范围证明必须使用当前页候选与连续来源原文', () => {
  const input = { text: '先核对审核表，发布任务不变', candidates: [{ candidateId: 'a' }] }
  const binding = { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['当前审核表'], assessments: [{ candidateId: 'a', relation: 'independent', reason: '明确发布不变', sourceQuote: '发布任务不变' }] }
  assert.doesNotThrow(() => validateContextRequests('R', binding, input))
  assert.throws(() => validateContextRequests('R', { ...binding, assessments: [{ ...binding.assessments[0], sourceQuote: '我猜无关' }] }, input), /SCOPE_PROOF_INVALID/)
  assert.throws(() => validateContextRequests('R', { ...binding, assessments: [{ ...binding.assessments[0], candidateId: 'other-page' }] }, input), /SCOPE_PROOF_INVALID/)
})

test('conversation必须声明Agent任务集合边界', () => {
  const binding = { kind: 'binding', disposition: 'conversation', candidateId: null, evidence: ['查询已承接Task'] }
  assert.throws(() => validateContextRequests('R', binding, {}), /CONVERSATION_SCOPE_REQUIRED/)
  assert.doesNotThrow(() => validateContextRequests('R', { ...binding, queryScope: 'agent_tasks' }, {}))
})

test('准入接收者识别不依赖50字窗口或修复处理关键词，不继承他人点名', () => {
  assert.equal(isDirectedTaskRequest('小小鹏你在嘛，现在帮忙看一下第一个sheet页，70条数据集的审核状态', ['小小鹏']), true)
  assert.equal(isDirectedTaskRequest('小小鹏，' + '要求'.repeat(80) + '写完脚本，然后小鹏审批', ['小小鹏']), true)
  assert.equal(isDirectedTaskRequest('@其他人 处理以上需求', ['小小鹏']), false)
})


test('旧持久snapshot缺replyObligation仍可通过Host领取S节点，不虚构回应责任', async t => {
  const dir=await mkdtemp(join(tmpdir(),'old-snapshot-'))
  const store=await openExecutionStore({dbPath:join(dir,'control.sqlite'),instanceId:'test',initialize:true})
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true})})
  const run={runId:'old',sourceKey:'old-source',sourceVersion:1,actorId:'actor',conversationId:'group',body:'查询材料'}
  await store.command({id:'receive',kind:'message.receive',args:run})
  const snapshot=await prepareMessageContext(run,{})
  delete snapshot.replyObligation
  await store.command({id:'snapshot',kind:'message.snapshot',args:{runId:run.runId,snapshot}})
  const input=splitContext(snapshot)
  assert.equal(Object.hasOwn(input,'replyObligation'),false)
  const claimed=await store.command({id:'claim',kind:'message.node.claim',args:{leaseWindowMs:60500,runId:run.runId,unitId:'$',nodeId:'S',input,estimatedInputTokens:100,maxOutputTokens:100}})
  assert.equal(claimed.result.node.status,'running')
})


test('多span范围证明不能把跨gap拼接文字伪装成连续原文', async () => {
 const snapshot=await prepareMessageContext({sourceKey:'s',sourceVersion:1,actorId:'a',conversationId:'g',body:'第一事项，中间另一事项，末尾限制'},{})
 const input={...unitContext(snapshot,{spans:[{start:0,end:4},{start:12,end:16}],goalText:'第一事项',constraints:[]}),candidates:[{candidateId:'candidate'}]}
 const output={kind:'binding',disposition:'new',candidateId:null,evidence:['核验'],assessments:[{candidateId:'candidate',relation:'independent',reason:'不同事项',sourceQuote:input.text}]}
 assert.throws(()=>validateContextRequests('R',output,input),/MESSAGE_SCOPE_PROOF_INVALID/)
 assert.doesNotThrow(()=>validateContextRequests('R',{...output,assessments:[{...output.assessments[0],sourceQuote:'第一事项'}]},input))
})


test('I与IB阶段授权只接受当前事项连续原文及quote内逐字objective', () => {
 const source='线上先执行这两条，刷完找我验证，我验证通过，再刷这69条正式数据'
 const context={text:source,sourceSegments:[source],executionMaterialRefs:[]}
 const authorization={workflowId:'task-data-change',sourceQuote:'我验证通过，再刷这69条正式数据',objective:'再刷这69条正式数据',gate:'confirmation'}
 const intent={kind:'intent',actions:[{intent:'revise',arguments:{objective:source,stageAuthorizations:[authorization]},dependsOn:[]}],constraints:[],requiredExecutionMaterials:[],replyPolicy:'none'}
 for(const stage of ['I','IB']) {
  const validate=value=>validateExecutionMaterialRefs(stage,stage==='I'?value:{kind:'topic_intents',decisions:[{unitId:'unit',intent:value}]},stage==='I'?context:{units:[{unitId:'unit',input:context}]})
  assert.doesNotThrow(()=>validate(intent))
  for(const invalid of [{...authorization,objective:'仅在用户本人验证通过后处理69条正式数据。'},{...authorization,sourceQuote:'不存在的批准原文',objective:'批准'}]) {
   const output=structuredClone(intent);output.actions[0].arguments.stageAuthorizations=[invalid]
   assert.throws(()=>validate(output),/MESSAGE_STAGE_AUTHORIZATION_INVALID/)
  }
 }
})


test('I与IB采用Host已核验准入，不因缺少重新点名重复询问承接', () => {
 for(const stage of ['I','IB']) {
  const prompt=messageSystem(stage)
  assert.match(prompt,/facts.actorMayCreate=true表示Host已经核验/)
  assert.match(prompt,/不得仅因本条没有重新点名而询问是否交给助手处理/)
  assert.match(prompt,/准入允许不等于动作意图/)
  assert.match(prompt,/任务准入也不等于生产执行或审批授权/)
 }
})
