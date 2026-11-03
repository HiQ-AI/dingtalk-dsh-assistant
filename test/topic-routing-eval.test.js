import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { modelInput, scoreScenario, summarize, validateDataset } from '../docs/acceptance/topic-routing-quality/scripts/score.mjs'
import { collectObservation, fixtureIssues } from '../docs/acceptance/topic-routing-quality/scripts/run.mjs'

const scenario = {
  id: 'one', family: 'family-one', split: 'development',
  input: { group: { id: 'g', responsibility: '处理测试事项' }, topics: [{ id: 'topic-a', groupId: 'g', title: '盘点' }, { id: 'topic-b', groupId: 'g' }], tasks: [{ id: 'task-a', topicId: 'topic-a' }], messages: [{ messageId: 'm1', text: '补充原任务' }] },
  expected: { routeStatus: 'routed', routes: [{ messageId: 'm1', source: '补充原任务', topic: 'topic-a' }], actions: [{ kind: 'task-context', taskId: 'task-a' }], candidateTopicIds: ['topic-a', 'topic-b'] },
}

test('首屏 topics 独立计入候选且不支持多任务播种', () => {
  const observation = collectObservation({ group: { topics: [], messages: [] }, input: { messages: [] }, actualToExpected: new Map([['real', 'candidate']]), taskIds: new Map(), requests: [{ tools: [] }], toolResults: [], native: { latestInput: () => ({ topics: [{ topicId: 'real' }] }), modelToolValues: () => [] }, resolveTopicMessages: () => [] })
  assert.deepEqual(observation.candidates, ['candidate'])
  assert.ok(fixtureIssues({ input: { tasks: [{ state: 'running', ownerActorId: 'a' }, { state: 'waiting', ownerActorId: 'a' }] } }).includes('fixture_multiple_tasks_unavailable'))
})

test('八类场景的开发和留出集均有覆盖', async () => {
  const scenarios = JSON.parse(await readFile(new URL('../docs/acceptance/topic-routing-quality/fixtures/scenarios.json', import.meta.url)))
  assert.equal(validateDataset(scenarios).scenarios, 120)
  const categories = Object.groupBy(scenarios, item => item.category)
  assert.equal(Object.keys(categories).length, 8)
  for (const items of Object.values(categories)) assert.deepEqual(new Set(items.map(item => item.split)), new Set(['development', 'holdout']))
  const recovery = scenarios.find(item => item.id === 'context-02').input
  assert.deepEqual(recovery.initialRoutingHold, { messageId: 'm1', messageVersion: 1, epoch: 0, reason: '供应商不明确' })
  assert.equal(recovery.events.find(event => event.quotedMessageId)?.quotedMessageId, recovery.initialRoutingHold.messageId)
  assert.ok(recovery.events.some(event => event.kind === 'observe-hold'))
  const badRecovery = structuredClone(scenarios.find(item => item.id === 'context-02'))
  badRecovery.input.events[0].messageId = 'missing'
  assert.ok(fixtureIssues(badRecovery).includes('fixture_hold_events_invalid'))
  const cancel = scenarios.find(item => item.id === 'task-02').input
  assert.equal(cancel.tasks[0].ownerActorId, cancel.messages[0].senderId)
})

test('完整场景及其对照不得跨开发和留出分组', () => {
  assert.equal(validateDataset([scenario]).scenarios, 1)
  assert.throws(() => validateDataset([scenario, { ...scenario, id: 'two', split: 'holdout' }]), /split_leakage/)
  assert.throws(() => validateDataset([scenario, { ...scenario, id: 'two', family: 'other', constructionFamily: 'family-one', split: 'holdout' }]), /construction_split_leakage/)
  assert.throws(() => validateDataset([scenario, { ...scenario, id: 'two', family: 'other', split: 'holdout' }]), /input_leakage/)
  assert.throws(() => validateDataset([{ ...scenario, input: { ...scenario.input, group: { ...scenario.input.group, expected: 'leak' } } }]), /embedded_labels/)
})

test('预测输入不含标注且复制隔离', () => {
  const input = modelInput(scenario)
  assert.equal(input.expected, undefined)
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.equal(hash(input), hash(modelInput({ ...scenario, expected: { routes: [], actions: [] } })))
  input.messages[0].text = 'changed'
  assert.equal(scenario.input.messages[0].text, '补充原任务')
})

test('路由、动作及候选召回分别评分，缺少输出不可记为正确', () => {
  const result = scoreScenario(scenario, { routeStatus: 'routed', routes: scenario.expected.routes, actions: [], candidates: ['topic-a', 'topic-c'] })
  assert.equal(result.routeCorrect, true)
  assert.equal(result.actionKindTargetCorrect, false)
  assert.equal(result.candidateRecall, 0.5)
  assert.deepEqual(summarize([result]), { scenarios: 1, routeExact: 1, actionKindTargetExact: 0, candidateRecall: 0.5, semanticReview: { pending: 1, reviewed: 0, fail: 0 } })
  assert.equal(result.review.authorization.status, 'pending')
  const actual = { routeStatus: 'routed', routes: [], actions: [], candidates: [] }
  const binding = scoreScenario(scenario, actual)
  const review = { scenarioDigest: binding.scenarioDigest, observationDigest: binding.observationDigest }
  assert.throws(() => scoreScenario(scenario, actual, { ...review, dimensions: { authorization: { status: 'pass' } } }), /invalid_human_review/)
  assert.throws(() => scoreScenario(scenario, { ...actual, candidates: ['topic-a'] }, review), /stale_human_review/)
  const reviewed = scoreScenario(scenario, actual, { ...review, dimensions: { authorization: { status: 'fail', reviewer: 'reviewer', evidence: '无授权来源' } } })
  assert.equal(reviewed.semanticReview, 'fail')
  assert.throws(() => scoreScenario(scenario, { routes: [], actions: [] }), /missing_observation/)
  assert.equal(scoreScenario(scenario, { routeStatus: 'routed', routes: [...scenario.expected.routes, ...scenario.expected.routes], actions: scenario.expected.actions, candidates: [] }).routeCorrect, false)
})

test('新建事项按来源分区比对，不比较动态标题或 ID', () => {
  const expected = { ...scenario, input: { ...scenario.input, messages: [{ messageId: 'm1', text: '甲事项；乙事项。' }] }, expected: { ...scenario.expected, routes: [
    { messageId: 'm1', source: '甲事项', topic: 'new:first' }, { messageId: 'm1', source: '乙事项', topic: 'new:second' },
  ] } }
  const observation = { routeStatus: 'routed', routes: [
    { messageId: 'm1', source: '甲事项', topic: 'new:uuid-a' }, { messageId: 'm1', source: '乙事项', topic: 'new:uuid-b' },
  ], actions: [], candidates: [] }
  assert.equal(scoreScenario(expected, observation).routeCorrect, true)
  observation.routes[1].source = '乙事项。'
  assert.equal(scoreScenario(expected, observation).routeCorrect, true)
  observation.routes[1].topic = 'new:uuid-a'
  assert.equal(scoreScenario(expected, observation).routeCorrect, false)
})

test('同标题跨群候选不能冒充本群 Topic', () => {
  const foreign = { ...scenario, input: { ...scenario.input, topics: [...scenario.input.topics, { id: 'foreign-topic', groupId: 'other', title: '盘点' }] } }
  assert.throws(() => validateDataset([{ ...foreign, expected: { ...foreign.expected, candidateTopicIds: ['foreign-topic'] } }]), /invalid_candidate_label/)
  const result = scoreScenario(foreign, { routeStatus: 'routed', routes: [{ ...scenario.expected.routes[0], topic: 'foreign-topic' }], actions: scenario.expected.actions, candidates: ['foreign-topic'] })
  assert.equal(result.routeCorrect, false)
  assert.equal(result.candidateRecall, 0)
})
