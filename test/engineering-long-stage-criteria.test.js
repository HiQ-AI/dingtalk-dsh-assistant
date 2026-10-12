import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { createTaskOwnerController } from '../packages/dingtalk-dsh-assistant/task-owner-controller.js'

const workflow = id => ({ id, version: '1', nodes: [{
  id: 'produce', version: '1', executor: 'code', allowedEffects: ['pure'],
  inputSchema: { type: 'number' }, outputSchema: { type: 'number' },
  mapInput: ({ requirement }) => requirement,
  execute: async ({ input }) => input + 1,
}] })
const runFile = promisify(execFile)

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stage-plan-'))
  const dbPath = join(directory, 'control.sqlite'), instanceId = 'plan-test'
  const store = await openExecutionStore({ dbPath, instanceId, initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(directory, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts, workflows: [workflow('investigate'), workflow('implement')] })
  t.after(async () => { await controller.close(); await store.close(); await rm(directory, { recursive: true, force: true }) })
  return { store, artifacts, controller, dbPath, instanceId }
}

test('long stage acceptance criteria retain source evidence without a 2000 character cap',async t=>{
 const {controller,store}=await setup(t),body='Implement the original business requirement',criteria='original acceptance requirement '.repeat(180)
 await store.command({id:'long-source',kind:'message.receive',args:{runId:'long-source',sourceKey:'long-source',sourceVersion:1,actorId:'owner',conversationId:'group',body,context:{},policy:{}}})
 const condition={sourceKey:'long-source',sourceVersion:1,sourceQuote:body,objective:body,repositoryId:'project',acceptanceCriteria:[criteria]}
 await controller.createTaskPlan({commandId:'long-plan',taskId:'long-goal',stages:[{stageId:'long',workflowId:'implement',input:2,sourceCondition:condition}]})
 assert.equal((await controller.taskPlan('long-goal')).stages[0].sourceCondition.acceptanceCriteria[0],criteria)
 await assert.rejects(controller.createTaskPlan({commandId:'bad-source',taskId:'bad-source',stages:[{stageId:'long',workflowId:'implement',input:2,sourceCondition:{...condition,sourceQuote:'different source'}}]}),{code:'TASK_STAGE_SOURCE_CONDITION_INVALID'})
})
