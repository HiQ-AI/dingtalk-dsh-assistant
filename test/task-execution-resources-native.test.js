import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, modelToolValues } from './fixtures/task-session-native-host.js'

const call = (name, args) => ({ name, args })
const submit = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: [], limitations: [] } })

// 真实 Host 和账本串联两轮同会话续办；模型只脚本化选工具，不伪造资源回执。
for (const resourceKeys of [['uat2'], []]) test(`执行原生工具读取自身租约并在续办刷新，初始资源=${resourceKeys.join(',') || 'none'}`, { skip: !available ? reason : false, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-own-resources-'))
  const observed = []
  let executorCalls = 0
  const h = await nativeTaskHost(root, async request => {
    if (request.tools.some(tool => tool.name === 'task_delegate')) {
      const input = latestInput(request), execution = input.executions[0]
      if (!execution) return [call('task_delegate', { key: 'initial', objective: '读取自己的当前资源租约', resourceKeys }), submit('wait', '等待租约核验')]
      if (!execution.drained) return [submit('wait', '等待执行排空')]
      if (execution.inputVersion === 1) return [call('task_delegate', { key: 'continued', executionId: execution.executionId, objective: '续办后核验更新的资源租约', resourceKeys: ['uat3'] }), submit('wait', '等待续办核验')]
      return [submit('complete', '已核对两轮独立租约')]
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
