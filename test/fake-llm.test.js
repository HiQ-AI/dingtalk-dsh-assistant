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
