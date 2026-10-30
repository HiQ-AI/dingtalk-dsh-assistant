import { fixedUnitRequestId, platformTaskPage, platformScheduleSessionId as sessionKey, platformScheduleOutboundId as outboundKey } from './fixed-topics.js'
import { sessionWorkspace, nameSession } from './session-workspaces.js'
import { groupReplyInstructions } from './group-message.js'
import { z } from 'zod'
import { createPlatformNotifier, platformNotificationContext, platformReplyParameters } from './platform-notification.js'
import { groupNotificationInstructions } from './group-notification.js'

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const deliveryPrompt = binding => `执行原群已授权的一次平台事项：${binding.prompt}\n约定时间 ${binding.at}，原群 ${binding.groupId}。必须先使用 platform_task_query 核对本群事实，再用 platform_reply_submit 提交；这两个工具未就绪时等待宿主恢复，不自行发群、不改排时间、不创建业务任务。已过期时判断补报或失去意义而静默，不能把入站提醒当已交付。`
const matchesNative = (binding, record) => record?.kind === 'at' && record.sessionId === binding.sessionId && record.scheduledAt === binding.at
  && record.prompt === deliveryPrompt(binding) && record.title === binding.title && (!binding.scheduleId || binding.scheduleId === record.id)

// Native Schedule owns timing, storage and cold-session delivery. This bridge
// owns only the accepted source binding and its existing outbox identity.
export function createPlatformSchedules({ ctx, store, legacy, root, models, readTasks, appendOutbox, notify = createPlatformNotifier({ store, root, appendOutbox }), now = Date.now }) {
  let closed = false
  const flights = new Map(), mounted = new Map(), recovered = new Set()
  let recovery = Promise.resolve()
  const source = binding => {
    if (closed) return null
    const message = store.getGroup(binding.groupId)?.messages.find(item => item.messageId === binding.messageId && item.messageVersion === binding.messageVersion)
    const unit = message?.units?.find(item => item.unitId === binding.unitId && item.unitRevision === binding.unitRevision && item.fixedTopic === 'agent-platform')
    return unit && message.activeUnitRefs?.some(ref => ref.unitId === unit.unitId && ref.unitRevision === unit.unitRevision)
      && fixedUnitRequestId(binding.groupId, message, unit) === binding.requestId ? { message, unit } : null
  }
  const settle = (binding, outcome) => store.updatePlatformSchedule(binding.sessionId, { outcome, completedAt: new Date(now()).toISOString() })
  async function deliver(binding, decision) {
    const current = source(binding)
    if (!current) throw new Error('platform_schedule_source_stale')
    const outboundId = outboundKey(binding.requestId), message = current.message
    await notify({ groupId: binding.groupId, outboundId, message, unit: current.unit, decision, sessionId: binding.sessionId,
      preflight: () => { if (!source(binding)) throw new Error('platform_schedule_source_stale') } })
    await settle(binding, 'replied')
  }
  const mount = async agent => {
    const binding = store.getPlatformSchedule?.(String(agent.session.id))
    if (!binding || binding.sessionId !== sessionKey(binding.requestId) || closed || mounted.has(agent)) return
    const agentCtx = agent.ctx, disposers = [], pages = new Map()
    let snapshot, submission = Promise.resolve()
    agentCtx.get('permissionPresets').set(agent.session, 'danger-full-access')
    const assert = exec => {
      if (exec.agent !== agent || !source(binding)) throw new Error('platform_schedule_source_stale')
    }
    disposers.push(agentCtx.tools.register({ name: 'platform_task_query', description: '查询本群到期执行时的真实任务快照，按 nextCall 读完所有页后答复。',
      parameters: { type: 'object', properties: { state: { enum: ['running', 'completed', 'all'] }, day: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false }, output,
      execute: async (args, exec) => {
        assert(exec)
        snapshot ??= { tasks: await readTasks(binding.groupId), asOf: now() }
        const page = platformTaskPage(snapshot.tasks, args, { groupId: binding.groupId, timezone: binding.timezone, now: snapshot.asOf })
        const key = JSON.stringify([args.state ?? 'all', args.day ?? null, args.limit ?? 50]), consumed = pages.get(key)?.consumed ?? 0
        if ((args.offset ?? 0) > consumed) throw new Error('platform_task_page_gap')
        pages.set(key, { consumed: Math.max(consumed, page.nextOffset), total: page.total })
        return page
      } }))
    disposers.push(agentCtx.tools.register({ name: 'platform_reply_submit', description: '提交本次到期结果到原群可靠发件箱。仅失去意义的过期提醒用 text=null 静默结清；有价值的汇报仍补报并注明实际时间。',
      parameters: platformReplyParameters, output,
      execute: (decision, exec) => submission = submission.catch(() => {}).then(async () => {
        const { text } = decision
        assert(exec)
        const saved = store.getPlatformSchedule(binding.sessionId)
        if (saved.outcome) return { status: saved.outcome }
        if (text === null) { await settle(binding, 'expired'); return { status: 'expired' } }
        if (typeof text !== 'string' || !text.trim()) throw new Error('platform_reply_empty')
        if ([...pages.values()].some(page => page.consumed < page.total)) throw new Error('platform_task_pages_unread')
        await deliver(binding, decision)
        return { status: 'accepted', outboundId: outboundKey(binding.requestId) }
      }) }))
    disposers.push(agentCtx.on('agent/pre-step', async (_event, next) => {
      if (closed || store.getPlatformSchedule(binding.sessionId).outcome) return { kind: 'reject' }
      if (!source(binding)) { await settle(binding, 'superseded'); return { kind: 'reject' } }
      if (Date.parse(binding.at) > now()) return { kind: 'reject' }
      const saved = store.getPlatformSchedule(binding.sessionId)
      const native = (await ctx.get('schedule').catalog()).find(record => matchesNative(saved, record))
      if (!native) {
        await settle(binding, 'superseded'); return { kind: 'reject' }
      }
      if (!saved.scheduleId) await store.updatePlatformSchedule(binding.sessionId, { scheduleId: native.id })
      const previous = store.getGroup(binding.groupId).outbox.find(item => item.outboundId === outboundKey(binding.requestId))
      if (previous) { await deliver(binding); return { kind: 'reject' } }
      return next()
    }))
    disposers.push(agentCtx.systemPrompt.section({ name: 'dingtalk-platform-schedule', order: 120, text: `这是宿主持有的独立平台定时会话，仅执行原用户已交办的一次事项，不创建业务任务，不重新安排同一提醒。原群=${binding.groupId}；约定时间=${binding.at}；默认时区=${binding.timezone}；本次恢复时刻=${new Date(now()).toISOString()}。原消息=${JSON.stringify(source(binding)?.unit.sourceRanges ?? [])}。事项：${binding.prompt}。到期汇报先调用 platform_task_query 读取本群最新事实，分页读全，再调用 platform_reply_submit 提交原群答复，普通自然语言不会发送。结合原消息的明确时区与实际执行时刻重新核对目标；已过期的有价值汇报补报一次并注明实际时间和延迟，失去意义的定点提醒可 text=null 静默结清，不得改排明天。只有不确定且影响执行才澄清。宿主的 schedule 送入会话回执不代表汇报已发送；只有原群通知账确认才称送达。` }))
    disposers.push(agentCtx.systemPrompt.section({ name: 'dingtalk-group-reply', order: 119, text: groupReplyInstructions }))
    disposers.push(agentCtx.systemPrompt.section({ name: 'dingtalk-notification', order: 121,
      text: `${groupNotificationInstructions}\n受信原请求与近期群上下文（不代表全部都要通知）：${JSON.stringify(platformNotificationContext(store.getGroup(binding.groupId), source(binding)?.message ?? {}))}` }))
    mounted.set(agent, disposers)
  }
  const stopCreated = ctx.on?.('agent/created', ({ agent }) => mount(agent))
  const stopDisposed = ctx.on?.('agent/disposed', ({ agent }) => mounted.delete(agent))
  // Schedule can restore a due Session before Resident finishes loading. Its
  // durable inbox receipt is the only admission for one recovery after idle;
  // ordinary successful turns need no additional model call or timer.
  const recover = () => {
    recovery = recovery.catch(() => {}).then(async () => {
      if (closed) return
      const schedule = ctx.get?.('schedule'), controller = ctx.get?.('sessionController')
      if (!schedule || !controller) return
      for (const record of await schedule.catalog()) {
        const binding = store.getPlatformSchedule?.(record.sessionId)
        if (!binding || binding.outcome || !matchesNative(binding, record) || record.status !== 'inactive' || !record.lastDelivery || recovered.has(record.id)) continue
        const result = await controller.resolveAgent(record.sessionId)
        if (result.error) throw result.error
        if (closed) return
        await mount(result.agent); await result.agent.whenIdle()
        if (closed || store.getPlatformSchedule(record.sessionId).outcome) continue
        recovered.add(record.id)
        result.agent.followup({ id: `${record.id}-platform-recovery`, role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text',
          text: `[SCHEDULE REMINDER]\n原生定时已在 ${record.lastDelivery.deliveredAt} 投入本会话，平台工具现已就绪。沿原事项补报或判断过期，只通过 platform_reply_submit 结清；不要创建新的 schedule。` }] })
      }
    })
    void recovery.catch(error => ctx.logger?.warn?.(`platform schedule recovery: ${error.message}`))
  }
  const stopChanged = ctx.on?.('schedule/changed', recover)
  ctx.inject?.(['schedule'], () => { recover() })
  async function prepare(binding) {
    const schedule = ctx.get('schedule')
    if (!schedule?.create || !ctx.get('sessionController')) throw new Error('platform_native_schedule_unavailable')
    if (!source(binding)) throw new Error('platform_schedule_source_stale')
    // Recover a native create committed before its local receipt, including an
    // already-fired entry. Never recreate a deleted, previously accepted record.
    const existing = store.getPlatformSchedule(binding.sessionId)
    if (existing && ['title', 'prompt', 'at', 'timezone'].some(key => existing[key] !== binding[key])) throw new Error('platform_schedule_identity_conflict')
    const native = existing ? (await schedule.catalog()).find(item => item.sessionId === binding.sessionId) : null
    if (native) {
      if (!matchesNative(existing, native)) throw new Error('platform_schedule_identity_conflict')
      await store.updatePlatformSchedule(binding.sessionId, { scheduleId: native.id })
      return { status: native.status === 'active' ? 'scheduled' : 'triggered', scheduleId: native.id, at: native.scheduledAt }
    }
    if (existing?.scheduleId || existing?.outcome) return { status: existing.outcome ?? 'cancelled', scheduleId: existing.scheduleId }
    if (Date.parse(binding.at) <= now()) return { status: 'expired', at: binding.at }
    await store.preparePlatformSchedule(binding)
    if (!await ctx.sessionPersistence.stat(binding.sessionId)) {
      const cwd = await sessionWorkspace(root, 'platform')
      // This is a new Host-owned ordinary Session, not a relabelled child. The
      // calling platform child retains its original origin and delegation depth.
      const handle = await ctx.agents.withoutInitiator(() => ctx.agents.create({ sessionId: binding.sessionId,
        meta: { cwd, agentPreset: legacy.getAgentConfig().agentPreset },
        agentOptions: typeof models === 'function' ? models() : models,
        setup: async (agentCtx, agent) => {
          const preset = await agentCtx.get('agentPresets').mount(agentCtx, legacy.getAgentConfig().agentPreset)
          if (!ctx.sessionProjections.stateOf(agent.session, 'agentPreset')) agent.session.append('agent-preset/selected', { agentPreset: preset.id })
          agentCtx.get('permissionPresets').set(agent.session, 'danger-full-access')
        } }))
      try {
        nameSession(ctx, handle.agent.session, 'platform', binding.title)
        if (!await ctx.sessions.flush(handle.agent.session)) throw new Error('platform_schedule_session_not_persisted')
      } finally { await handle.dispose() }
    }
    if (!source(binding)) throw new Error('platform_schedule_source_stale')
    const record = await schedule.create(binding.sessionId, { title: binding.title, prompt: deliveryPrompt(binding), at: binding.at })
    await store.updatePlatformSchedule(binding.sessionId, { scheduleId: record.id })
    return { status: 'scheduled', scheduleId: record.id, at: record.scheduledAt }
  }
  return {
    async submit(sourceBinding, { title, prompt, at }) {
      if (typeof at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) throw new Error('platform_schedule_time_requires_offset')
      if (!z.string().datetime({ offset: true }).safeParse(at).success) throw new Error('platform_schedule_time_invalid')
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new Error('platform_schedule_invalid')
      const binding = { ...sourceBinding, sessionId: sessionKey(sourceBinding.requestId), title: title.trim(), prompt: prompt.trim(), at: new Date(at).toISOString() }
      const previous = flights.get(binding.sessionId) ?? Promise.resolve()
      const work = previous.catch(() => {}).then(() => prepare(binding))
      flights.set(binding.sessionId, work)
      try { return await work } finally { if (flights.get(binding.sessionId) === work) flights.delete(binding.sessionId) }
    },
    async close() {
      closed = true; stopCreated?.(); stopDisposed?.(); stopChanged?.()
      for (const agent of mounted.keys()) agent.cancel({ kind: 'user' })
      await Promise.allSettled([...flights.values(), recovery])
      for (const [agent, disposers] of mounted) { await agent.whenIdle(); for (const dispose of disposers) dispose?.() }
      mounted.clear()
    },
  }
}
