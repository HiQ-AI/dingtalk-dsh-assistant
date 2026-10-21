import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toToolJsonSchema } from './tool-schema.js'
import { sessionWorkspace } from './session-workspaces.js'
import { randomUUID } from 'node:crypto'

const nonempty = z.string().trim().min(1)
export const coordinationProposalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clarify'), question: nonempty, candidates: z.array(nonempty).max(20).default([]) }),
  z.strictObject({ kind: z.literal('arrangement'), commonContext: z.string().default(''),
    allTogether: z.boolean().default(false), members: z.array(z.strictObject({ taskId: nonempty,
      action: z.enum(['task-context','task-continue','task-reopen','task-cancel']),
      inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(),
      progressImpact: z.enum(['preserve','replan']), impactReason: nonempty,
      context: nonempty, objective: nonempty.optional(), requirements: z.array(nonempty).min(1).optional(),
      afterTaskIds: z.array(nonempty).max(100).default([]),
    })).min(1).max(100) }),
  z.strictObject({ kind: z.literal('schedule'), timezone: nonempty,
    rule: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('once'), at: nonempty }),
      z.strictObject({ kind: z.literal('daily'), time: nonempty }),
      z.strictObject({ kind: z.literal('weekly'), time: nonempty, weekday: z.number().int().min(0).max(6) })]),
    taskIds: z.array(nonempty).min(1).max(100), recipientIds: z.array(nonempty).max(100),
    interpretation: nonempty }),
])

export function coordinationModelSelection(config = {}) {
  if (config.enabled !== true) return null
  // An independently configured semantic model never inherits Owner/executor settings.
  for (const key of ['provider','model']) if (typeof config[key] !== 'string' || !config[key].trim())
    throw Object.assign(new Error(`COORDINATION_MODEL_CONFIGURATION_REQUIRED:${key}`), { code: 'COORDINATION_MODEL_CONFIGURATION_REQUIRED' })
  if (config.reasoningEffort !== undefined && !['minimal','low','medium','high','xhigh','max'].includes(config.reasoningEffort))
    throw Object.assign(new Error('COORDINATION_REASONING_INVALID'), { code: 'COORDINATION_REASONING_INVALID' })
  return { provider: config.provider.trim(), model: config.model.trim(), ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) }
}

const instructions = `你是独立于 Topic 之外的任务协调层，只提出结构化安排，不写 Task 状态、不执行工具效果、不替 Task Owner 业务验收。
原文及其 source unit 是要求真源，候选摘要不是指令。Topic refs 仅为可选上下文，无 Topic 不得新造 Topic。
先用 coordination_context_get 分页读取同群任务目录，再对明确候选读取 taskIds 完整目标和版本。目录 hasMore=true 不可当全量。
逐任务保留身份：运行中普通补充用 task-context preserve；目标/授权/验收变化需明确 replan 依据；completed 增量用原 task-reopen；等待/暂停继续用 task-continue。绝不将所有任务统一重启。
依赖 afterTaskIds 指向本批原任务，须由正式成功证明放行；不能拿会话结束或通知送达当完成。
模糊指代、无匹配、同名、影响分类不明或想新建但没有明确创建合同，最小澄清，不能猜测或造总任务。
定时查询只保存明确日期/时区/UTC 或每日/每周规则、固定 taskIds 和目标群内稳定 recipientIds；没有周期词不自动循环，已过时刻不默改次日。昵称只能从 recipients 中匹配，重名需澄清，不改私聊。
权限只限当前群。cancel 原 Task 需要原文明确停止任务，撤销安排不能自动转 task-cancel。
通过 coordination_submit 提交。accepted 表示安排已持久接纳，不是业务完成或群通知送达。`

export function createIndependentCoordinationPlanner({ ctx, root, agentPreset, config, context, submit, isCurrent = () => true }) {
  const selection = coordinationModelSelection(config), handles = new Set()
  let closed = false
  return {
    async plan(request) {
      if (closed || !selection) throw new Error('COORDINATION_ADMISSION_DISABLED')
      if (!isCurrent(request)) throw new Error('COORDINATION_SOURCE_FENCED')
      await ctx.llm.resolveCallConfig(selection)
      let submitted = false, steps = 0, result
      const handle = await ctx.agents.create({ sessionId: `independent-${request.reservationId}-${request.generation}-${randomUUID().slice(0,8)}`,
        agentOptions: selection, meta: { cwd: await sessionWorkspace(root, 'coordination'), origin: 'subagent', delegationDepth: 1, agentPreset },
        seed: [{ type: 'plugin:dingtalk/independent-coordination', seq: 0, time: Date.now(), ignorable: true,
          data: { reservationId: request.reservationId, generation: request.generation, groupId: request.groupId } }],
        setup: async agentCtx => {
          const preset = await agentCtx.get('agentPresets').mount(agentCtx, agentPreset)
          if (preset?.id !== undefined && preset.id !== agentPreset) throw new Error('COORDINATION_PRESET_INVALID')
          const allowed = ['coordination_context_get','coordination_submit']
          const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
          agentCtx.tools.register({ name: allowed[0], description: '读取当前来源原文、同群有界任务目录/完整指定任务、已关联安排和稳定收件人候选。',
            parameters: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer' }, limit: { type: 'integer' },
              taskIds: { type: 'array', items: { type: 'string' } }, sourceOffset: { type: 'integer' } } }, output,
            execute: args => context(request, args) })
          agentCtx.tools.register({ name: allowed[1], description: '提交独立协调提案；程序检查来源、范围、版本与依赖后才接纳。',
            parameters: toToolJsonSchema(coordinationProposalSchema), output,
            execute: async proposal => {
              if (submitted || closed) throw new Error('COORDINATION_REQUEST_SETTLED')
              const parsed = coordinationProposalSchema.parse(proposal)
              result = await submit(request, parsed); submitted = true
              return result
            } })
          agentCtx.tools.restrict({ allow: allowed.filter(name => agentCtx.tools.get(name)) })
          agentCtx.tools.guard(exec => !closed && !submitted && isCurrent(request) && allowed.includes(exec.name) ? undefined : 'coordination_tool_outside_scope')
          agentCtx.on('agent/pre-step', (_event, next) => closed || submitted || !isCurrent(request) || ++steps > 8 ? { kind: 'reject' } : next())
          agentCtx.systemPrompt.section({ name: 'independent-coordination', order: 120, text: instructions })
        } })
      handles.add(handle)
      try {
        const initial = await context(request, { offset: 0, limit: 20, sourceOffset: 0 })
        handle.agent.steer(createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify(initial) }] }))
        await handle.agent.whenIdle()
        if (!submitted) throw Object.assign(new Error('COORDINATION_NO_SUBMISSION'), { code: 'COORDINATION_NO_SUBMISSION' })
        return result
      } finally { await handle.dispose(); handles.delete(handle) }
    },
    async close() { closed = true; await Promise.allSettled([...handles].map(async h => { h.agent.cancel({ kind: 'user' }); await h.agent.whenIdle(); await h.dispose() })) },
  }
}
