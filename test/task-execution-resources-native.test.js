import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, resolveContextInput, waitUntil } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'
import { createTaskSessions } from '../packages/dingtalk-dsh-assistant/task-session.js'

const call = (name, args) => ({ name, args })
const submit = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })

test('原生资源目录工具驱动准备到发布的原会话续办，目录别名实际落为canonical锁', { skip: !available ? reason : false, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-resource-stage-'))
  await mkdir(join(root, '.dsh'))
  await writeFile(join(root, '.dsh', 'shared-resources.json'), JSON.stringify({ version: 1, resources: [
    { key: 'publish:example:uat', aliases: ['old:uat'], purpose: 'publication', description: '隔离测试发布目标' },
  ] }))
  let catalogRead = false
  const readRounds = new Set(), observed = []
  const h = await nativeTaskHost(root, async request => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!catalogRead) { catalogRead = true; return [call('task_resource_catalog', {})] }
      const execution = input.executions[0]
      if (!execution) {
        const directory = modelToolValues(request).findLast(item => item.enabled === true && item.version === 1)
        assert.equal(directory.resources[0].purpose, 'publication')
        return [call('task_delegate', { key: 'prepare', objective: '准备：本地核验源码', resourcePhase: 'prepare', resourceKeys: [] }), submit('wait', '等待本地准备结果')]
      }
      if (!execution.drained) return [submit('wait', '原执行尚未排空')]
      if (execution.resourcePhase === 'prepare') return [call('task_delegate', { key: 'publish', executionId: execution.executionId,
        objective: '发布：取得共享环境后核验准备结果', resourcePhase: 'publish', resourceKeys: ['old:uat'] }), submit('wait', '等待同一成员发布核验')]
      return [submit('complete', '两阶段的原生资源证据已核对')]
    }
    if (!readRounds.has(input.objective)) { readRounds.add(input.objective); return [call('execution_resources_read', {})] }
    const snapshot = modelToolValues(request).findLast(item => item.resources && item.executionId)
    assert.ok(snapshot)
    observed.push(snapshot)
    return [call('execution_submit', { output: { status: 'completed', summary: '已核对本轮阶段与资源', evidence: [], limitations: [], artifacts: [] } })]
  })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: 'native-resource-stage', objective: '准备后再联合取得发布资源，复用原执行' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed', JSON.stringify(h.service.listAlerts()))
  assert.equal(observed.length, 2)
  assert.equal(observed[0].resourcePhase, 'prepare')
  assert.equal(observed[0].resources.state, 'none')
  assert.equal(observed[1].resourcePhase, 'publish')
  assert.equal(observed[1].resources.state, 'held')
  assert.deepEqual(observed[1].resources.keys, ['publish:example:uat'])
  assert.equal(observed[1].executionId, observed[0].executionId)
  assert.equal(observed[1].sessionId, observed[0].sessionId)
  assert.equal((await h.query('execution.list', { taskId: task.taskId })).length, 1)
  assert.deepEqual(await h.query('resource.list'), [])
  assert.deepEqual(await h.query('operation.list'), [])
  assert.equal(h.toolResults.some(item => item.result.isError), false)
})

test('旧执行缺resourcePhase时原生读取仍为lossless JSON，旧Host未提供目录回调可只读空目录', { skip: !available ? reason : false, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-resource-legacy-view-'))
  let step = 0
  const h = await nativeTaskHost(root, async () => step++ === 0
    ? [call('task_resource_catalog', {}), call('task_execution_read', { executionId: 'legacy-execution' })]
    : [submit('wait', '旧执行读取成功')], { resident: true })
  const manager = createTaskSessions({ ctx: h.ctx, isCurrent: async () => true, getWorkspaceDir: async () => root })
  t.after(async () => { try { await manager.close(); await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const result = await manager.run({ binding: { kind: 'task-session', taskId: 'legacy-task', sessionId: 'legacy-owner', leaseEpoch: 1, sessionBound: false },
    provider: 'native-task-test', model: 'controlled', agentPreset: 'native-test', input: { task: { title: '旧执行读取', objective: '保留历史记录' }, wakes: [] },
    onSessionBound: async () => {}, submit: async () => ({ accepted: true }),
    readExecution: async () => ({ executionId: 'legacy-execution', inputVersion: 1, status: 'succeeded', document: null,
      resources: { state: 'released', keys: [], holder: null, blocking: [] } }),
  })
  assert.equal(result.status, 'submitted')
  const reads = h.toolResults.filter(item => ['task_resource_catalog', 'task_execution_read'].includes(item.name))
  assert.equal(reads.length, 2)
  assert.ok(reads.every(item => !item.result.isError), JSON.stringify(reads))
})

// 真实 Host 和账本串联两轮同会话续办；模型只脚本化选工具，不伪造资源回执。
for (const resourceKeys of [['uat2'], []]) test(`执行原生工具读取自身租约并在续办刷新，初始资源=${resourceKeys.join(',') || 'none'}`, { skip: !available ? reason : false, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-own-resources-'))
  const observed = []
  let executorCalls = 0, reviewDispatched = false
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const input = latestInput(request), execution = input.executions[0]
      if (!execution) return [call('task_delegate', { key: 'initial', objective: '读取自己的当前资源租约', resourceKeys }), submit('wait', '等待租约核验')]
      if (!execution.drained) return [submit('wait', '等待执行排空')]
      if (execution.inputVersion === 1) return [call('task_delegate', { key: 'continued', executionId: execution.executionId, objective: '续办后核验更新的资源租约', resourceKeys: ['uat3'] }), submit('wait', '等待续办核验')]
      if (!reviewDispatched) {
        reviewDispatched = true
        return [call('task_delegate', { key: 'identity-review', objective: '协作核对：只读确认原成员续办保留身份' }),
          call('task_delegate', { key: 'result-review', objective: '协作核对：只读确认原成员两轮租约结果' }), submit('wait', '等待两项核对')]
      }
      if (input.executions.some(item => !item.drained)) return [submit('wait', '等待核对排空')]
      return [submit('complete', '已核对两轮独立租约')]
    }
    if (latestInput(request).objective.startsWith('协作核对')) {
      const projected = modelToolValues(request).findLast(item => Array.isArray(item.executions) || item.contextReadRequired)
      if (!projected) return [call('execution_team_read', {})]
      let team
      try { team = resolveContextInput(request, projected) }
      catch (error) { if (error.contextReads) return error.contextReads.map(args => call('model_content_read', args)); throw error }
      const original = team.executions.find(item => item.inputVersion === 2)
      assert.ok(original?.result)
      return [call('execution_submit', { output: { status: 'completed', summary: '已核对原成员续办身份和结果', evidence: [original.executionId], limitations: [], artifacts: [] } })]
    }
    const step = executorCalls++
    assert.ok(request.tools.some(tool => tool.name === 'execution_resources_read'))
    if (step === 0) return [call('execution_resources_read', { executionId: 'foreign-execution' })]
    if (step === 1 || step === 3) return [call('execution_resources_read', {})]
    const value = modelToolValues(request).findLast(item => item.resources && item.executionId)
    assert.ok(value, '模型应收到 Host 真实查询结果')
    observed.push(value)
    return [call('execution_submit', { output: { status: 'completed', summary: '已核对自身当前租约', evidence: [], limitations: [], artifacts: [] } })]
  })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: `own-resources-${resourceKeys.length}`, objective: '只读核验自身资源，分两轮执行' })
  await h.service.whenIdle()
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.equal(observed.length, 2)
  assert.equal(observed[0].resources.state, resourceKeys.length ? 'held' : 'none')
  assert.deepEqual(observed[0].resources.keys, resourceKeys)
  assert.equal(observed[1].executionId, observed[0].executionId)
  assert.equal(observed[1].sessionId, observed[0].sessionId)
  assert.ok(observed[1].inputVersion > observed[0].inputVersion)
  assert.ok(observed[1].leaseEpoch > observed[0].leaseEpoch)
  assert.deepEqual(observed[1].resources.keys, ['uat3'])
  assert.equal(observed[1].resources.holder, `execution:${observed[1].executionId}`)
  const [execution] = await h.query('execution.list', { taskId: task.taskId })
  assert.deepEqual(execution.feedback ?? [], [], '不需要统筹反馈补发持锁证明')
  assert.deepEqual(await h.query('operation.list', { taskId: task.taskId }), [], '内部只读工具不生成外部操作')
  assert.deepEqual((await h.query('task.get', { taskId: task.taskId })).humanRequests, [])
  const reads = h.toolResults.filter(item => item.name === 'execution_resources_read')
  assert.equal(reads.length, 3)
  assert.equal(reads[0].result.isError, true, '模型不能指定其他 executionId')
})

for (const maxConcurrentExecutions of [1, 3]) test(`同任务原生定向通信持久消费且不重启终态成员：并发${maxConcurrentExecutions}`, { skip: !available ? reason : false, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-peer-messages-'))
  const sent = Promise.withResolvers(), receipts = [], steps = new Map()
  t.after(() => sent.resolve())
  const done = summary => call('execution_submit', { output: { status: 'completed', summary, evidence: [], limitations: [], artifacts: [] } })
  const h = await nativeTaskHost(root, async (request, host) => {
    const input = latestInput(request)
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      if (!input.executions.length) return [
        call('task_delegate', { key: 'producer', objective: 'producer：发送接口证据位置' }),
        call('task_delegate', { key: 'consumer', objective: 'consumer：核对接口交接' }),
        call('task_delegate', { key: 'auditor', objective: 'auditor：核对完成状态与通信回执' }), submit('wait', '已安排三个不同职责')]
      return [submit(input.executions.length === 3 && input.executions.every(item => item.drained && item.status === 'succeeded') ? 'complete' : 'wait', '按实际结果核对团队')]
    }
    const role = input.objective.split('：')[0], step = steps.get(role) ?? 0
    const values = modelToolValues(request)
    let team
    if ((role === 'producer' || role === 'auditor') && step > 0) {
      const projected = values.findLast(item => item.executions || item.contextReadRequired)
      try { team = resolveContextInput(request, projected) }
      catch (error) { if (error.contextReads) return error.contextReads.map(args => call('model_content_read', args)); throw error }
    }
    steps.set(role, step + 1)
    if (role === 'producer') {
      if (step === 0) {
        await waitUntil(async () => (await host.query('execution.list', { taskId: input.task.taskId })).length === 3, '三名成员已登记')
        return [call('execution_team_read', {})]
      }
      const receiver = team.executions.find(item => item.objective.startsWith('consumer'))
      if (step === 1 || step === 2) return [call('execution_send_message', { executionId: receiver.executionId, targetInputVersion: receiver.inputVersion,
        key: 'interface-ready', message: '接口字段为amountCents；证据artifact://contract-v1，固定版本v1，只核对约定字段，不追加部署。' })]
      receipts.push(...values.filter(item => item.messageId))
      sent.resolve()
      return [done('已交接固定接口证据')]
    }
    if (role === 'consumer') {
      await sent.promise
      const peer = request.messages.find(message => message.source?.kind === 'execution-peer')
      if (!peer) return [call('execution_resources_read', {})]
      assert.match(JSON.stringify(peer), /amountCents/)
      assert.match(JSON.stringify(peer), /不是用户授权/)
      return [done('已核对同任务接口交接')]
    }
    if (step === 0) {
      await waitUntil(async () => (await host.query('execution.list', { taskId: input.task.taskId })).find(item => item.key === 'consumer')?.status === 'succeeded', '收件成员已完成')
      return [call('execution_team_read', {})]
    }
    if (step === 1) {
      const receiver = team.executions.find(item => item.objective.startsWith('consumer'))
      return [call('execution_send_message', { executionId: receiver.executionId, targetInputVersion: receiver.inputVersion, key: 'terminal-check', message: '核对终态不会触发重启。' })]
    }
    assert.ok(values.some(item => item.received === false && item.reason === 'recipient_finished'))
    return [done('已核对终态不自动重启')]
  }, { config: { maxConcurrentExecutions } })
  t.after(async () => { try { await h.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const task = await h.service.createTask({ groupId: 'native-group', requestId: `peer-${maxConcurrentExecutions}`, objective: '三成员按固定接口交换必要证据并核对状态' })
  await h.service.whenIdle()
  const executions = await h.query('execution.list', { taskId: task.taskId }), receiver = executions.find(item => item.key === 'consumer')
  assert.equal((await h.query('task.get', { taskId: task.taskId })).status, 'completed')
  assert.equal(executions.length, 3)
  assert.equal(receiver.inputVersion, 1)
  assert.equal(receiver.leaseEpoch, 1)
  assert.equal(receiver.feedback.length, 1, '同key重试只落一条消息，终态不投递')
  assert.ok(receiver.feedback[0].consumedAt)
  assert.ok(Number.isInteger(receiver.feedback[0].sequence))
  assert.ok(receipts.some(item => item.messageId === receiver.feedback[0].id))
  const producer = executions.find(item => item.key === 'producer')
  const producerHistory = await inspectSession(h.ctx.sessionPersistence, producer.sessionId)
  const sends = producerHistory.events.filter(item => item.type === 'tool/call' && item.data.name === 'execution_send_message')
  assert.equal(sends.length, 2, '原生模型确实重试同一消息')
  assert.deepEqual(JSON.parse(sends[0].data.arguments), JSON.parse(sends[1].data.arguments))
  assert.equal(h.toolResults.filter(item => item.name === 'execution_send_message' && !item.result.isError).length, 3, '两次幂等发送及一次终态回执均成功返回')
  const history = await inspectSession(h.ctx.sessionPersistence, receiver.sessionId)
  const messages = history.events.filter(item => item.type === 'user/message' && item.data.source?.kind === 'execution-peer')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].seq, receiver.feedback[0].sequence)
  assert.deepEqual(await h.query('operation.list', { taskId: task.taskId }), [], '内部通信不生成外部效果账')
})
