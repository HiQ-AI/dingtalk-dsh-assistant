import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installFakeLlm } from '../packages/dingtalk-dsh-assistant/fake-llm.js'

test('fake adapter 产出完整 dsh 流式 chunk 协议', async () => {
  let adapter
  const ctx = { llm: { registerAdapter(providers, value) { assert.deepEqual(providers, ['fake-resident']); adapter = value } } }
  installFakeLlm(ctx)
  const chunks = []
  const direct = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const reminder = createUserMessage({ content: [{ type: 'text', text: 'system reminder' }], source: { kind: 'plugin', plugin: 'test' } })
  for await (const chunk of adapter.stream({ messages: [direct, reminder] })) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'fake-main-reply:hello')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('fake adapter 对群消息使用step Decision工具而不是assistant JSON文本', async () => {
  let adapter
  const ctx = { llm: { registerAdapter(_providers, value) { adapter = value } } }
  installFakeLlm(ctx)
  const request = createUserMessage({ content: [{ type: 'text', text: '[GROUP_MESSAGE_STEER]\n判断请求 ID：request-1\n消息唯一标识：m1\n内容：任务：核验提交协议' }], source: { kind: 'user' } })
  const chunks = []
  for await (const chunk of adapter.stream({ messages: [request] })) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].name, 'group_decision_submit')
  const args = JSON.parse(chunks[1].argumentsDelta)
  assert.deepEqual(args.observedRequestIds, ['request-1'])
  assert.deepEqual(args.submissions[0].requestIds, ['request-1'])
  assert.equal(args.submissions[0].decision.actions[0].kind, 'new-task')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('fake adapter 对 Task 协调通知使用可靠回复工具提交', async () => {
  let adapter
  const ctx = { llm: { registerAdapter(_providers, value) { adapter = value } } }
  installFakeLlm(ctx)
  const request = createUserMessage({ content: [{ type: 'text', text: '[TASK_COORDINATION]\n回复请求 ID：reply-1\nTask ID: task-1\n任务：核验回复门禁' }], source: { kind: 'user' } })
  const chunks = []
  for await (const chunk of adapter.stream({ messages: [request] })) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].name, 'group_reply_submit')
  assert.deepEqual(JSON.parse(chunks[1].argumentsDelta), { requestId: 'reply-1', observedRequestIds: [], reply: 'coordinated:task-1' })
})
