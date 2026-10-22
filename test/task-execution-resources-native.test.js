import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues, resolveContextInput, waitUntil } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

const call = (name, args) => ({ name, args })
const submit = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })

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
      const team = modelToolValues(request).findLast(item => Array.isArray(item.executions))
      if (!team) return [call('execution_team_read', {})]
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
