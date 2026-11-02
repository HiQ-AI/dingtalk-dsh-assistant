import assert from 'node:assert/strict'
import test from 'node:test'
import { compactReplyReviewCandidates } from '../packages/dingtalk-dsh-assistant/decision.js'
import { createTaskContextReadTool } from '../packages/dingtalk-dsh-assistant/task-topic-coordinator.js'

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


for (const change of ['ended', 'revision', 'versionRequestId']) test('pending archived Task read cannot mark review after request '+change, async () => {
  const request = { groupId: 'g', requestId: 'r', revision: 1, versionRequestId: 'v1' }
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  let current = true, reviews = 0
  const tool = createTaskContextReadTool({ request, assert() { if (!current) throw new Error('request_ended') }, store: { getTask() {} },
    readArchivedTask: async () => { entered.resolve(); await released.promise; return { taskId: 't', groupId: 'g', archivedAt: '2026-11-02' } },
    readReplyReview() { reviews++; return {} } })
  const pending = tool.execute({ taskIds: ['t'], includeReplyReview: true })
  await entered.promise
  if (change === 'ended') current = false
  else request[change] = change === 'revision' ? 2 : 'v2'
  released.resolve()
  await assert.rejects(pending, /request_ended|coordination_task_read_stale/)
  assert.equal(reviews, 0)
})

test('Route Task read does not advertise or accept Decision review option', async () => {
  const tool = createTaskContextReadTool({request:{groupId:'g'},assert(){},store:{getTask(){throw new Error('must not read')}}})
  assert.equal(tool.parameters.properties.includeReplyReview,undefined)
  assert.equal((await tool.execute({taskIds:['t'],includeReplyReview:true})).status,'invalid-arguments')
})
