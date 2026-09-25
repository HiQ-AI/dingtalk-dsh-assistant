import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionController } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'
import { openWorkflowService } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'

// 只复用两条消息的语义；消息 ID、群、用户、数据库和适配器都是本测试的隔离夹具。
const messages = [
  { groupId: 'fixture-group', messageId: 'fixture-51', senderOpenDingTalkId: 'fixture-owner',
    occurredAt: '2026-09-24T15:28:41+08:00', text: 'test3 632546662@qq.com 广东省环境科学研究院 小小鹏，这个账号是你创建的测试账号吗？为什么创建时间是空的呢？从什么渠道创建的账号时间会空呢？' },
  { groupId: 'fixture-group', messageId: 'fixture-52', senderOpenDingTalkId: 'fixture-owner',
    occurredAt: '2026-09-24T15:29:26+08:00', text: '这不是让你去查吗' },
]
const schema = { type: 'object', additionalProperties: true }
const split = text => ({ kind: 'split', units: [{ spans: [{ start: 0, end: text.length }], goalText: text, constraints: [], contextNeeds: [] }],
  coverage: [{ start: 0, end: text.length, role: 'unit' }], sharedConstraints: [] })
const intent = actions => ({ kind: 'intent', actions, constraints: [], requiredExecutionMaterials: [], replyPolicy: 'none' })

test('隔离重演账号补充消息：同话题且意图可见已执行事实，外部效果为零', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-isolated-account-followup-'))
  const child = relative(tmpdir(), root)
  assert.ok(child && child.startsWith('dsh-isolated-account-followup-') && !child.startsWith('..') && !isAbsolute(child))
  const dbPath = join(root, 'control.sqlite')
  assert.ok(relative(root, dbPath) === 'control.sqlite')
  const store = await openExecutionStore({ dbPath, instanceId: 'isolated-test', initialize: true })
  const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
  const controller = createExecutionController({ store, artifacts,
    delivery: { execute: async () => { throw new Error('EXTERNAL_EFFECT_FORBIDDEN') } },
    workflows: [{ id: 'task-analysis', version: 'isolated-test', nodes: [{ id: 'analyze', version: '1', executor: 'code',
      allowedEffects: ['pure'], inputSchema: schema, outputSchema: schema, mapInput: ({ requirement }) => requirement,
      execute: async () => ({ summary: '已分析现有消息，尚未查询账号系统。', evidenceIds: [], limitations: ['缺少账号创建记录和渠道日志'] }) }] }],
  })
  let sendCalls = 0, recallCalls = 0, firstTopicId, secondTopicId, sawTaskFacts = false, sawRecentSource = false
  const notifications = {
    canDisclose: async () => true,
    send: async () => { sendCalls++; throw new Error('DWS_SEND_FORBIDDEN') },
    recall: async () => { recallCalls++; throw new Error('DWS_RECALL_FORBIDDEN') },
    readback: async () => { throw new Error('DWS_READBACK_FORBIDDEN') },
  }
  const judge = async ({ stage, input }) => {
    if (stage === 'S') return split(input.source.text)
    if (stage === 'R') {
      if (input.text === messages[0].text) return { kind: 'binding', disposition: 'new', candidateId: null, evidence: ['原始账号提问'] }
      sawRecentSource = input.recentMessages?.some(item => item.text?.includes('test3')) === true
      const candidate = input.candidates.find(item => item.goal?.includes('test3') || item.title?.includes('test3'))
      assert.ok(candidate, '补充消息应看到原账号问题的话题候选')
      return { kind: 'binding', disposition: 'existing', candidateId: candidate.candidateId, evidence: ['原始账号提问与短指代的查证目标一致'] }
    }
    if (stage === 'IB') return { kind: 'topic_intents', decisions: input.units.map(unit => {
      const followup = unit.input.text === messages[1].text
      if (followup) {
        const tasks = unit.input.facts?.topicTasks?.tasks ?? unit.input.facts?.tasks ?? []
        sawTaskFacts = tasks.some(task => task.status === 'succeeded' && task.result?.summary?.includes('尚未查询账号系统')
          && task.result?.limitations?.some(value => value.includes('账号创建记录')))
        assert.ok(sawTaskFacts, '后续意图须看到已执行 Run 与结果限制')
      }
      return { unitId: unit.unitId, intent: followup
        ? intent([{ intent: 'no_action', arguments: {}, dependsOn: [] }])
        : intent([{ intent: 'create', arguments: { objective: '分析 test3 账号现有材料', workflowId: 'task-analysis' }, dependsOn: [] }]) }
    }) }
    throw new Error(`UNEXPECTED_STAGE:${stage}`)
  }
  const service = await openWorkflowService({ ctx: {}, config: { groupIds: ['fixture-group'], ownerActorId: 'fixture-owner', profile: 'isolated-test' },
    legacy: { getAgentConfig: () => ({ provider: 'test', model: 'test' }), getGroup: groupId => ({ groupId, responsibility: '处理本人交办事项', messages: [] }) },
    judge, execution: { store, artifacts, controller }, notifications })
  t.after(async () => { await service.close(); await controller.close(); await store.close(); await rm(root, { recursive: true, force: true }) })
  async function waitForState(runId, ready) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await service.state(runId)
      if (ready(state)) return state
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const state = await service.state(runId)
    assert.fail(`隔离判断未完成：${state.run.reason ?? state.run.status}`)
  }

  const first = await service.ingest(messages[0])
  await service.messages.process(first.runId)
  const firstState = await waitForState(first.runId, state => state.commands[0]?.status === 'applied' && state.commands[0]?.result?.runId)
  firstTopicId = firstState.units[0].topicId
  assert.ok(firstTopicId, firstState.run.reason ?? '首条消息未绑定话题')
  assert.equal(firstState.commands.length, 1)
  await controller.whenIdle(firstState.commands[0].result.runId)

  const second = await service.ingest(messages[1])
  await service.messages.process(second.runId)
  const secondState = await waitForState(second.runId, state => state.units[0]?.topicId && state.run.status === 'settled')
  secondTopicId = secondState.units[0].topicId
  assert.equal(secondTopicId, firstTopicId)
  assert.equal(sawRecentSource, true)
  assert.equal(sawTaskFacts, true)
  assert.equal(sendCalls, 0)
  assert.equal(recallCalls, 0)
  assert.equal((await store.query({ kind: 'run.list', limit: 20 })).length, 1)
})
