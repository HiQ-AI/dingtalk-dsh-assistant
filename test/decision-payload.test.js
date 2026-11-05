import assert from 'node:assert/strict'
import test from 'node:test'
import { compactReplyReviewCandidates } from '../packages/dingtalk-dsh-assistant/decision.js'
import { createTaskContextReadTool, taskDecisionView } from '../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'

const expand = data => data.candidates.map(({ sourceMessageRefs, taskFactRefs, ...candidate }) => ({ ...candidate,
  sourceMessages: sourceMessageRefs.map(ref => data.sourceMessages.find(item => item.ref === ref).value),
  tasks: taskFactRefs.map(ref => data.tasks.find(item => item.ref === ref).value),
}))
test('shared review wire format preserves every fact and distinguishes same identity with changed content', () => {
  const source={messageId:'m',text:'fact '.repeat(100)}, task={taskId:'t',objective:'scope '.repeat(60),state:'running'}
  const candidates=Array.from({length:6},(_,i)=>({outboundId:'o'+i,reply:'reply',sourceMessages:[source],tasks:[task]}))
  const compact=compactReplyReviewCandidates(candidates)
  assert.deepEqual(expand(compact),candidates)
  assert.equal(compact.sourceMessages.length,1);assert.equal(compact.tasks.length,1)
  assert.ok(JSON.stringify(compact).length<JSON.stringify(candidates).length)
  const variants=compactReplyReviewCandidates([...candidates,{outboundId:'changed',sourceMessages:[{...source,text:'new version'}],tasks:[{...task,state:'completed'}]}])
  assert.equal(variants.sourceMessages.length,2);assert.equal(variants.tasks.length,2)
  assert.deepEqual(expand(variants).at(-1).sourceMessages[0].text,'new version')
})
test('Task decision view retains full authorization and history without internal dispatch state', async () => {
  const task = { taskId: 't', groupId: 'g', inputVersion: 3, runSequence: 2, contextRevision: 4, controlRevision: 5,
    objective: '只核对', request: '不修改生产\n\n[话题补充]\n不发送通知', requirements: ['记录证据'],
    metadata: { authorizationSourceId: 'source-1' }, humanRequests: [{ status: 'answered', answer: '仍不得发送' }],
    appliedOperations: ['internal-operation'], leaseEpoch: 9, sessionBound: true, claimContextRevision: 4 }
  const view = taskDecisionView(task)
  assert.equal(view.request, task.request)
  assert.deepEqual(view.requirements, task.requirements)
  assert.deepEqual(view.metadata, task.metadata)
  assert.deepEqual(view.humanRequests, task.humanRequests)
  assert.equal(view.contextRevision, 4); assert.equal(view.controlRevision, 5)
  assert.equal('appliedOperations' in view, false); assert.equal('leaseEpoch' in view, false)
  view.metadata.authorizationSourceId = 'changed'
  assert.equal(task.metadata.authorizationSourceId, 'source-1')
  const tool = createTaskContextReadTool({ request: { groupId: 'g' }, assert() {}, store: { getTask: () => task } })
  assert.deepEqual((await tool.execute({ taskIds: ['t'] })).tasks, [taskDecisionView(task)])
})

test('combined Task/review read is opt-in and validates source/group before exposing review', async () => {
  let reviews=0, allowed=true
  const task={taskId:'t',groupId:'g',objective:'scope',inputVersion:2,runSequence:2}
  const tool=createTaskContextReadTool({request:{groupId:'g',requestId:'r'},assert(){assert.ok(allowed)},store:{getTask:id=>id==='t'?task:{taskId:id,groupId:'foreign'}},
    readReplyReview(g,ids,compact){reviews++;assert.equal(g,'g');assert.deepEqual(ids,['r']);assert.equal(compact,true);return {candidates:[],candidateCount:0}}})
  assert.deepEqual(await tool.execute({taskIds:['t']}),{tasks:[task]});assert.equal(reviews,0)
  const combined=await tool.execute({taskIds:['t'],includeReplyReview:true});assert.deepEqual(combined.tasks,[task]);assert.equal(combined.replyReview.candidateCount,0);assert.equal(reviews,1)
  await assert.rejects(tool.execute({taskIds:['foreign'],includeReplyReview:true}),/wrong_group/);assert.equal(reviews,1)
  assert.equal((await tool.execute({taskIds:['t'],includeReplyReview:'yes'})).status,'invalid-arguments')
  allowed=false;await assert.rejects(tool.execute({taskIds:['t'],includeReplyReview:true}));assert.equal(reviews,1)
})


test('Task read registers the exact returned view only after the request remains current', async () => {
  const request = { groupId: 'g', requestId: 'r', versionRequestId: 'v1', revision: 2 }
  const recorded = []
  const tool = createTaskContextReadTool({ request, assert() {}, store: { getTask: () => ({ taskId: 't', groupId: 'g', request: '保留限制' }) },
    onTaskContextRead: (captured, result) => recorded.push({ captured, result: structuredClone(result) }) })
  const first = await tool.execute({ taskIds: ['t'] })
  const second = await tool.execute({ taskIds: ['t'] })
  assert.deepEqual(recorded[0], { captured: { requestId: 'r', versionRequestId: 'v1', revision: 2 }, result: first })
  assert.equal(first.tasks[0].request, '保留限制')
  assert.notEqual(first.readId, second.readId)
})

for (const change of ['ended', 'revision', 'versionRequestId']) test('pending archived Task read cannot mark review after request '+change, async () => {
  const request = { groupId: 'g', requestId: 'r', revision: 1, versionRequestId: 'v1' }
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  let current = true, reviews = 0, reads = 0
  const tool = createTaskContextReadTool({ request, assert() { if (!current) throw new Error('request_ended') }, store: { getTask() {} },
    readArchivedTask: async () => { entered.resolve(); await released.promise; return { taskId: 't', groupId: 'g', archivedAt: '2026-11-02' } },
    readReplyReview() { reviews++; return {} }, onTaskContextRead() { reads++ } })
  const pending = tool.execute({ taskIds: ['t'], includeReplyReview: true })
  await entered.promise
  if (change === 'ended') current = false
  else request[change] = change === 'revision' ? 2 : 'v2'
  released.resolve()
  await assert.rejects(pending, /request_ended|coordination_task_read_stale/)
  assert.equal(reviews, 0)
  assert.equal(reads, 0)
})

test('Route Task read does not advertise or accept Decision review option', async () => {
  const tool = createTaskContextReadTool({request:{groupId:'g'},assert(){},store:{getTask(){throw new Error('must not read')}}})
  assert.equal(tool.parameters.properties.includeReplyReview,undefined)
  assert.equal((await tool.execute({taskIds:['t'],includeReplyReview:true})).status,'invalid-arguments')
})
