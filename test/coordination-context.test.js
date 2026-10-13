import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { visibleToolOutputs, visiblePromptRefs, visibleSectionLength } from '../packages/dingtalk-dsh-assistant/coordination-context.js'

const call = (id, name) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: '{}' }] })
const result = (callId, value, isError = false) => createToolResultMessage({ callId, isError, content: [{ type: 'text', text: JSON.stringify(value) }] })
const agentFor = messages => ({ session: { deriveMessages: () => messages } })

test('V4 visible materials require a successful tool-role result paired with an allowed call', () => {
  const prompt = { id: 'p', name: 'prompt', description: '', prompt: 'read this', revision: 1 }
  const payload = { prompts: [prompt] }
  const messages = [
    call('good', 'group_task_prompt_get'), result('good', payload),
    call('failed', 'group_task_prompt_get'), result('failed', { prompts: [{ ...prompt, id: 'failed' }] }, true),
    call('other', 'unrelated_tool'), result('other', { text: 'unrelated' }),
    result('unknown', { text: 'unpaired' }),
    { role: 'user', content: [{ type: 'text', text: JSON.stringify({ text: 'user retelling' }) }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'good', content: [{ type: 'text', text: JSON.stringify({ text: 'legacy wrapper' }) }] }] },
  ]
  assert.deepEqual(visibleToolOutputs(agentFor(messages)), [payload])
  assert.deepEqual(visiblePromptRefs(agentFor(messages), [prompt, { ...prompt, revision: 2 }]), [{ id: 'p', revision: 1 }])
})

test('V4 paginated visible context keeps exact text matching and invalidates on surface changes', () => {
  const messages = [call('page', 'group_topic_context_get'), result('page', { offset: 0, nextOffset: 3, text: 'abc' })]
  const agent = agentFor(messages)
  agent.session.surface = { replaceGeneration: 0, nodes: [1] }
  assert.equal(visibleSectionLength(agent, 'abcdef'), 3)
  messages.push(call('next', 'group_decision_context_get'), result('next', { offset: 3, nextOffset: 6, text: 'def' }))
  agent.session.surface.nodes.push(2)
  assert.equal(visibleSectionLength(agent, 'abcdef'), 6)
  assert.equal(visibleSectionLength(agent, 'different'), 0)
  messages.splice(0)
  agent.session.surface.replaceGeneration++
  assert.deepEqual(visibleToolOutputs(agent), [])
})
