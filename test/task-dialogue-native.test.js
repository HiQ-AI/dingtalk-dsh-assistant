import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { available, reason, nativeTaskHost, latestInput, waitUntil } from './fixtures/task-session-native-host.js'
import { inspectSession } from '../packages/dingtalk-dsh-assistant/session-persistence.js'

const call = (name, args) => ({ name, args })
const reply = summary => call('task_session_submit', { decision: { action: 'wait', summary, evidence: [], limitations: [] } })

test('dialogue uses the same native owner, answers questions without feedback, steers the original execution and refuses restart', { ...({ skip: !available ? reason : false, timeout: 30000 }), timeout: nativeLifecycleTimeout(30000) }, nativeLifecycle(30000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-dialogue-native-')), gate = Promise.withResolvers()
t.onCancel(() => gate.resolve())

  const steps = new Map(); let delegated = false, executionSteps = 0
  await t.beginBusiness()
  await t.step(async () => writeFile(join(root, 'target.txt'), 'original evidence'))
  let h
  t.after(async () => { gate.resolve(); await h?.close(); await rm(root, { recursive: true, force: true }) })
  h = await t.step(async () => nativeTaskHost(root, async request => {
    if (!request.tools.some(tool => tool.name === 'task_delegate')) {
      if (++executionSteps === 1) return [call('read', { file_path: join(root, 'target.txt') })]
      await gate.promise
      return [call('execution_submit', { output: { status: 'completed', summary: '原执行完成', evidence: [], limitations: [], artifacts: [] } })]
    }
    const input = latestInput(request), message = input.dialogue
    if (message) {
      const step = steps.get(message.id) ?? 0; steps.set(message.id, step + 1)
      const executionId = input.executions[0].executionId
      if (message.id === 'question' && step === 0) return [call('read', { file_path: join(root, 'target.txt') })]
      if (message.id === 'reminder') {
        if (step === 0) return [call('task_execution_read', { executionId })]
        if (step === 1) return [call('task_delegate', { executionId, feedback: true, key: 'dialogue-reminder', objective: '保留原目标和授权，下一步检查错误记录' })]
        return [reply('已将提醒保存到原执行；尚不代表已消费或纠正完成。')]
      }
      if (message.id === 'change' && step === 0) return [call('task_delegate', { key: 'must-not-create', objective: '扩大目标并启动新执行' })]
      return [reply(message.id === 'change' ? '本对话不自动改变目标或停止原执行，请澄清是否仍在原范围内。' : '正在原执行中，尚未完成。')]
    }
    if (!delegated) { delegated = true; return [call('task_delegate', { key: 'original', objective: '只读检查目标文件' })] }
    return [reply('等待原执行')]
  }))
  const created = await t.step(async () => h.service.createTask({ groupId: 'native-group', requestId: 'original', objective: '只读核对目标文件' }))
  await t.step(async () => waitUntil(() => executionSteps >= 2, 'original execution running'))
  const taskId = created.taskId, sessionId = created.session.sessionId
  const original = (await t.step(async () => h.query('execution.list', { taskId })))[0]
  for (const [requestId, text] of [['question', '现在到哪一步了？'], ['reminder', '方向有些偏，目标不变，只需核对原错误记录。'], ['change', '改成修改所有配置并部署。']]) {
    const sent = await t.step(async () => h.service.sendTaskDialogue({ taskId, requestId, text }))
    assert.equal(sent.reply, null)
    await t.step(async () => waitUntil(async () => (await h.service.taskDialogue(taskId)).messages.find(item => item.id === requestId)?.reply, `reply ${requestId}`))
    assert.equal((await t.step(async () => h.service.taskDialogue(taskId))).sessionId, sessionId)
    const executions = await t.step(async () => h.query('execution.list', { taskId }))
    assert.equal(executions.length, 1)
    assert.equal(executions[0].executionId, original.executionId)
    assert.equal(executions[0].sessionId, original.sessionId)
    assert.equal(executions[0].leaseEpoch, original.leaseEpoch)
    assert.equal(executions[0].cancelRequested, false)
    assert.equal((await t.step(async () => h.query('task.get', { taskId }))).requirementRevision, 1)
    assert.equal(executions[0].feedback?.length ?? 0, requestId === 'question' ? 0 : 1)
  }
  assert.ok(h.toolResults.some(item => item.name === 'task_delegate' && JSON.stringify(item.result).includes('TASK_DIALOGUE_FEEDBACK_ONLY')))
  assert.match((await t.step(async () => h.service.taskDialogue(taskId))).messages[2].reply, /澄清/)
  await t.step(async () => h.service.sendTaskDialogue({ taskId, requestId: 'question', text: '现在到哪一步了？' }))
  assert.equal((await t.step(async () => h.service.taskDialogue(taskId))).messages.length, 3)
  gate.resolve(); await t.step(async () => h.service.whenIdle())
  const final = await t.step(async () => h.query('execution.get', { executionId: original.executionId }))
  assert.ok(final.feedback[0].consumedAt)
  const history = await t.step(async () => inspectSession(h.ctx.sessionPersistence, sessionId))
  assert.equal(history.events.filter(event => event.type === 'plugin:dingtalk/task-session').length, 1)
  assert.equal((await t.step(async () => h.service.taskDialogue(taskId))).messages.length, 3)
}))
