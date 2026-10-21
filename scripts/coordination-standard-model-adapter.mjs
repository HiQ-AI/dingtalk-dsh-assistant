import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { coordinationProposalSchema, coordinationPlannerInstructions } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'
import { toToolJsonSchema } from '../packages/dingtalk-dsh-assistant/tool-schema.js'

/** Accept an already authorized standard DSH llm service, never locate a runtime,
 * load configuration/credentials, install providers, or execute business tools.
 * Constructing this adapter has no side effects; only explicit plan() calls use
 * the supplied service. There are no harness-level retries.
 */
export function createStandardModelReplayAdapter({ llm, provider, model, reasoningEffort, maxInvocations = 16, timeoutMs = 30000 }) {
  if (typeof llm?.stream !== 'function' || typeof llm?.resolveCallConfig !== 'function'
    || typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()
    || !Number.isSafeInteger(maxInvocations) || maxInvocations < 1 || maxInvocations > 16
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('REPLAY_STANDARD_ADAPTER_CONFIG_INVALID')
  const selection = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  const records = []
  let invocations = 0
  return {
    identity: `standard-dsh:${provider}/${model}`,
    evidenceKind: 'actual-model',
    accounting: () => ({ standardStreamInvocations: invocations, providerNetworkCalls: null, records: structuredClone(records),
      limitation: 'Provider-internal retries/network requests and cost are not inferred from standard stream count.' }),
    async plan(input) {
      if (invocations >= maxInvocations) throw new Error('REPLAY_STANDARD_ADAPTER_BUDGET_EXHAUSTED')
      invocations++
      const record = { invocation: invocations, provider, model, completed: false }
      records.push(record)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('REPLAY_STANDARD_ADAPTER_TIMEOUT')), timeoutMs)
      try {
        // Freeze the selected registered provider/model via its standard API.
        const config = await llm.resolveCallConfig(selection, controller.signal)
        const system = `${coordinationPlannerInstructions}\n此次为无工具隔离语言回放。context已提供合成只读事实，不调用任何工具。仅输出符合以下schema的JSON，不输出Markdown：\n${JSON.stringify(toToolJsonSchema(coordinationProposalSchema))}`
        const messages = [createUserMessage({ source: { kind: 'coordinator' }, content: [{ type:'text', text:JSON.stringify(input) }] })]
        let text = '', finish
        for await (const chunk of llm.stream({ ...config, system, messages, tools: [], signal: controller.signal })) {
          if (controller.signal.aborted) throw controller.signal.reason
          if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call'
            || chunk.type === 'block-end' && chunk.block?.type === 'tool-call') throw new Error('REPLAY_STANDARD_ADAPTER_TOOL_FORBIDDEN')
          if (chunk.type === 'text-delta') text += chunk.text
          if (text.length > 100000) throw new Error('REPLAY_STANDARD_ADAPTER_OUTPUT_BUDGET')
          if (chunk.type === 'usage') record.usage = structuredClone(chunk.usage)
          if (chunk.type === 'finish') { finish = chunk.reason?.kind; record.finish = finish }
        }
        if (finish !== 'stop') throw new Error('REPLAY_STANDARD_ADAPTER_INCOMPLETE')
        const proposal = coordinationProposalSchema.parse(JSON.parse(text))
        record.completed = true
        return proposal
      } catch (error) { record.error = error.code ?? error.message; throw error }
      finally { clearTimeout(timeout); controller.abort() }
    },
  }
}
