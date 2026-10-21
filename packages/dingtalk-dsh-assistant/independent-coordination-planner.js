import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toToolJsonSchema } from './tool-schema.js'
import { sessionWorkspace } from './session-workspaces.js'
import { randomUUID } from 'node:crypto'

const nonempty = z.string().trim().min(1)
const existingMemberSchema = z.strictObject({ taskId: nonempty,
  action: z.enum(['task-context','task-continue','task-reopen','task-cancel']),
  inputVersion: z.number().int().positive(), runSequence: z.number().int().positive(),
  progressImpact: z.enum(['preserve','replan']), impactReason: nonempty,
  context: nonempty, objective: nonempty.optional(), requirements: z.array(nonempty).min(1).optional(),
  afterTaskIds: z.array(nonempty).max(100).default([]),
})
const newMemberSchema = z.strictObject({ action: z.literal('new-task'), creationKey: nonempty,
  title: nonempty, objective: nonempty, requirements: z.array(nonempty).min(1),
  taskId: nonempty.optional(), inputVersion: z.number().int().positive().optional(), runSequence: z.number().int().positive().optional(),
  progressImpact: z.enum(['preserve','replan']).default('replan'), impactReason: nonempty.default('用户明确要求新建'),
  context: z.string().default(''), afterTaskIds: z.array(nonempty).max(100).default([]),
})
export const coordinationMemberProposalSchema = z.union([existingMemberSchema, newMemberSchema])
const membersSchema = z.array(coordinationMemberProposalSchema).min(1).max(100)
const arrangementSchema = z.strictObject({ kind: z.literal('arrangement'), commonContext: z.string().default(''),
  allTogether: z.boolean().default(false), members: membersSchema })
const ruleSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('once'), at: nonempty }),
  z.strictObject({ kind: z.literal('daily'), time: nonempty }),
  z.strictObject({ kind: z.literal('weekly'), time: nonempty, weekday: z.number().int().min(0).max(6) })])
const scheduleSchema = z.strictObject({ kind: z.literal('schedule'), actionKind: z.enum(['read-query','task-command']).default('read-query'), timezone: nonempty,
  rule: ruleSchema, taskIds: z.array(nonempty).max(100).optional(), members: membersSchema.optional(),
  commonContext: z.string().default(''), allTogether: z.boolean().default(false),
  recipientIds: z.array(nonempty).max(100), interpretation: nonempty })
const selectorSchema = z.union([z.strictObject({ instructionId: nonempty }), z.strictObject({ ordinal: z.number().int().positive() })])
const controlChangeSchema = z.strictObject({ action: z.enum(['pause','resume','cancel']),
  selectors: z.array(selectorSchema).max(100).default([]), reason: nonempty })
const appendChangeSchema = z.strictObject({ action: z.literal('append'), members: membersSchema,
  commonContext: z.string().default(''), allTogether: z.boolean().default(false), reason: nonempty })
const reorderChangeSchema = z.strictObject({ action: z.literal('reorder'), dependencies: z.array(z.strictObject({
  instructionId: nonempty, afterInstructionIds: z.array(nonempty).max(100),
})).min(1).max(100), reason: nonempty })
export const coordinationProposalSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clarify'), question: nonempty, candidates: z.array(nonempty).max(20).default([]) }),
  z.strictObject({ kind: z.literal('reject'), reason: nonempty }),
  arrangementSchema, scheduleSchema,
  z.strictObject({ kind: z.literal('change'), coordinationId: nonempty, expectedRevision: z.number().int().positive(),
    change: z.union([controlChangeSchema, appendChangeSchema, reorderChangeSchema]) }),
  z.strictObject({ kind: z.literal('resolve'), coordinationId: nonempty, expectedRevision: z.number().int().positive(),
    resolution: z.discriminatedUnion('kind', [arrangementSchema, scheduleSchema]) }),
  z.strictObject({ kind: z.literal('schedule-change'), coordinationId: nonempty, expectedRevision: z.number().int().positive(),
    scheduleId: nonempty, expectedScheduleRevision: z.number().int().positive(),
    scope: z.enum(['future','unstarted']).default('future'), state: z.enum(['active','paused','cancelled']).optional(),
    rule: ruleSchema.optional(), timezone: nonempty.optional(), recipientIds: z.array(nonempty).max(100).optional(),
    replacementPlannedAt: nonempty.optional(), reason: nonempty }),
  z.strictObject({ kind: z.literal('occurrence-control'), coordinationId: nonempty, expectedRevision: z.number().int().positive(),
    occurrenceId: nonempty, expectedControlRevision: z.number().int().positive(), control: z.enum(['pause','resume','cancel']), reason: nonempty }),
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
用户明确要求新建时可用new-task成员，必填creationKey/title/objective/requirements；实际taskId由Host生成，依赖可引用creationKey，创建不表示获准启动。
后续“第二个先别动”等必须先通过coordination_context_get的coordinationIds读取真实原安排，再用change指向coordinationId/expectedRevision。selectors.ordinal按原memberIds固定顺序从1开始，不用当前任务目录顺序；pause/resume/cancel只控制安排，已生效工作可能无法撤回，不能自动停止原Task。reorder仅按明确改口更新原instructionId依赖，append仅在原文明确新增要求时提出，不自动补偿或重做。没有足够关联依据先clarify，不猜最近安排。
澄清回复必须用resolve关联原needs_clarification安排，保留原coordinationId并提出补全resolution，不能另造一张总安排替代。原安排的question/source与当前回复都需读取。
定时修改用schedule-change明确scheduleId/expectedScheduleRevision及future或unstarted影响范围；“只取消这一次”用occurrence-control和真实occurrenceId/instanceControlRevision，不能误取消以后所有。收件人变化只适用于尚未越过许可边界的冻结候选，已获许可或未知不承诺撤回。schedule.actionKind=task-command必须给members，read-query只给固定taskIds；定时触发不新增授权。
错误归类、原文没有协调意图时可reject，Host将先冻结并核对无命令，只有安全CAS交回后旧链才可接管；不能把reject当作已交回或已执行。
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
              taskIds: { type: 'array', items: { type: 'string' } }, coordinationIds: { type: 'array', items: { type: 'string' } }, sourceOffset: { type: 'integer' },
              arrangementSourceOffset: { type: 'integer' }, arrangementOffset: { type: 'integer' } } }, output,
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
