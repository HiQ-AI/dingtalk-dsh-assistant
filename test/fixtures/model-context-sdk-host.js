import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { createRequire } from 'node:module'
const { SessionProjectionRegistry } = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))('@deepseek-ai/dsh-session-projection')
export async function sdkHost(root, decide) {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
  new LlmRuntime(ctx); new ToolRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(root, 'sessions'), compression: 'none', packChunks: false, writeBatchMaxDelayMs: 1 })
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  let sequence = 0
  class Scripted extends LlmAdapter {
    async *stream(request) {
      for (const [index, call] of decide(request).entries()) {
        const id = 'synthetic-call-' + ++sequence, args = JSON.stringify(call.args)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['native-task-test'], new Scripted())
  return { ctx, close: () => ctx.fiber.dispose() }
}
