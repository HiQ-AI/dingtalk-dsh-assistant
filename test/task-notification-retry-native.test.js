import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from './fixtures/native-lifecycle.js'
import test from 'node:test'
import assert from 'node:assert/strict'

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { available, reason, nativeTaskHost, topicTaskCalls } from './fixtures/task-session-native-host.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { sendWorkflowNotification } from '../packages/dingtalk-dsh-assistant/group-message.js'

const refusal = { error: { category: 'api', code: 1, origin: 'mcp_gateway', operation: 'chat/get_conversation_info',
  reason: 'topic_quote_guard_unavailable', retryable: true, message: '无法确认引用回复目标是否属于话题圈，已阻止发送' } }

test('real native completed task retires its definitively unsent start confirmation without re-dispatch', { ...({ timeout: 10000, ...(!available ? { skip: reason } : {}) }), timeout: nativeLifecycleTimeout(10000) }, nativeLifecycle(10000, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'notification-terminal-native-'))
  let host, sends = 0, reads = 0
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, runner: { async run() {
    sends++
    return { exitCode: 1, stdout: '', stderr: JSON.stringify(refusal) }
  } } })
  await t.beginBusiness()
  host = await t.step(async () => nativeTaskHost(root, async request => topicTaskCalls(request) ?? [{ name: 'task_session_submit', args: {
    decision: { action: 'complete', summary: '已核验完整资料。', evidence: ['真实任务所有验收条件已满足'], limitations: [] },
  } }], { notifications: { send: notice => sendWorkflowNotification(adapter, notice), readback: async () => { reads++; return undefined } } }))
  await t.step(async () => host.service.ingest({ groupId: 'native-group', messageId: 'request', senderOpenDingTalkId: 'native-user',
    text: '测试助手，请核验资料并给出结论。', occurredAt: '2026-10-14T05:00:00Z' }))
  await t.step(async () => host.service.whenIdle())
  assert.equal((await t.step(async () => host.query('task.list')))[0].status, 'completed')
  await t.step(async () => host.service.recover()); await t.step(async () => host.service.whenIdle())
  const notice = (await t.step(async () => host.query('notification.list'))).find(row => row.payload.replyKind === 'confirmation')
  assert.equal(notice.state, 'failed')
  assert.equal(notice.retirement.reason, 'task-terminal')
  assert.equal(notice.deliveryError.knownNotSent, true)
  assert.equal(notice.deliveryError.retryable, false)
  assert.equal(notice.nextAttemptAt, null)
  assert.equal(sends, 1); assert.equal(reads, 0)
  assert.equal((await t.step(async () => host.query('task.list'))).length, 1)
}))
