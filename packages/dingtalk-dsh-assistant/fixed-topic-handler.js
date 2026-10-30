import { randomUUID } from 'node:crypto'
import { activeFixedUnits, fixedUnitRequestId, platformTaskPage } from './fixed-topics.js'
import { sessionWorkspace, nameSession } from './session-workspaces.js'
import { groupReplyInstructions } from './group-message.js'
import { createPlatformSchedules } from './platform-schedule.js'
import { createPlatformNotifier, platformNotificationContext, platformReplyParameters } from './platform-notification.js'
import { groupNotificationInstructions } from './group-notification.js'

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

// Fixed routes have no business Topic, Owner, or execution. Reply preparation uses the existing outbox.
export function createFixedTopicHandler({ ctx, store, legacy, root, models, appendOutbox, readTasks, readMentioned, onSettled = () => {}, onError = () => {}, now = Date.now }) {
  const flights = new Map(), handles = new Set()
  const notify = createPlatformNotifier({ store, root, appendOutbox })
  const schedules = createPlatformSchedules({ ctx, store, legacy, root, models, readTasks, appendOutbox, notify, now })
  let closed = false
  const current = (groupId, message, unit) => !closed && store.getGroup(groupId)?.messages.some(item => item.messageId === message.messageId
    && item.messageVersion === message.messageVersion && activeFixedUnits(item).some(value => value.unitId === unit.unitId && value.unitRevision === unit.unitRevision))
  async function process(groupId, message, unit) {
    const requestId = fixedUnitRequestId(groupId, message, unit)
    const previous = store.getGroup(groupId).outbox.find(item => item.outboundId === requestId)
    const finish = async () => { await store.markFixedTopicHandled({ groupId, messageId: message.messageId, messageVersion: message.messageVersion, unitId: unit.unitId, unitRevision: unit.unitRevision }); onSettled(groupId) }
    const reply = async (decision, sessionId) => {
      if (!current(groupId, message, unit)) throw new Error('fixed_topic_source_stale')
      if (!message.senderOpenDingTalkId) throw new Error('fixed_topic_reply_actor_required')
      await notify({ groupId, outboundId: requestId, message, unit, decision, sessionId,
        preflight: () => { if (!current(groupId, message, unit)) throw new Error('fixed_topic_source_stale') } })
      await finish()
    }
    // Reconcile the same frozen reply after a crash between outbox/notification preparation and unit settlement.
    if (previous) { await reply(); return }
    if (unit.fixedTopic === 'out-of-scope') {
      if (unit.outOfScopeHelp === true && (message.mentionedAgent === true || message.mentionedAgent === undefined && readMentioned && await readMentioned(groupId, message))) await reply({ text: '这个不是我负责哦', atOpenDingTalkIds: [message.senderOpenDingTalkId] })
      else await finish()
      return
    }
    let handle, submitted = false
    const timezone = store.getGroup(groupId).timezone ?? legacy.getAgentConfig().timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const asOf = now(), tasks = await readTasks(groupId)
    const pages = new Map()
    try {
      const agentPreset = legacy.getAgentConfig().agentPreset
      const sessionId = `session-platform-${randomUUID()}`
      handle = await ctx.agents.create({ sessionId,
        seed: [{ type: 'plugin:dingtalk/platform-query', seq: 0, time: asOf, ignorable: true, data: { groupId, requestId } }],
        meta: { cwd: await sessionWorkspace(root, 'platform'), origin: 'subagent', delegationDepth: 1, agentPreset },
        agentOptions: typeof models === 'function' ? models() : models,
        setup: async (agentCtx, agent) => {
          const presets = agentCtx.get('agentPresets')
          if (!presets) throw new Error('agent_presets_required')
          const preset = await presets.mount(agentCtx, agentPreset)
          if (preset?.id !== undefined && preset.id !== agentPreset) throw new Error('platform_agent_preset_invalid')
          const permissions = agentCtx.get('permissionPresets')
          if (!permissions?.set) throw new Error('platform_permission_presets_required')
          permissions.set(agent.session, 'danger-full-access')
          const assert = exec => {
            if (String(exec.agent?.session?.id) !== sessionId || !current(groupId, message, unit)) throw new Error('platform_query_wrong_session_or_source')
          }
          agentCtx.tools.register({ name: 'platform_task_query', description: '只读查询本群真实任务快照（包括归档）。state=running 为执行中；completed 为已完成。day 可为 yesterday、today 或 YYYY-MM-DD，按已声明时区筛选完成日期。hasMore=true 必须按 nextCall 继续，不能只读第一页就宣称全部。',
            parameters: { type: 'object', properties: { state: { enum: ['running', 'completed', 'all'] }, day: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false }, output,
            execute: (args, exec) => {
              assert(exec)
              const result = platformTaskPage(tasks, args, { groupId, timezone, now: asOf })
              const key = JSON.stringify([args.state ?? 'all', args.day ?? null, args.limit ?? 50])
              const previous = pages.get(key) ?? 0
              if ((args.offset ?? 0) > previous) throw new Error('platform_task_page_gap')
              pages.set(key, Math.max(previous, result.nextOffset))
              result.complete = pages.get(key) >= result.total
              return result
            } })
          agentCtx.tools.register({ name: 'platform_reply_submit', description: '通过可靠发信箱提交平台答复；自然语言输出不发送。仅当定点提醒已过期且失去意义时，text=null 静默结清；仍有价值的状态汇报应补报并说明实际时间。',
            parameters: platformReplyParameters, output,
            execute: async (decision, exec) => {
              const { text } = decision
              assert(exec)
              if (submitted) return { status: 'accepted' }
              if (text === null) { await finish(); submitted = true; return { status: 'expired' } }
              if (typeof text !== 'string' || !text.trim()) throw new Error('platform_reply_empty')
              // Every query made for this answer must have consumed its full result, including empty lists.
              for (const [key, consumed] of pages) {
                const [state, day, limit] = JSON.parse(key)
                if (consumed < platformTaskPage(tasks, { state, day: day ?? undefined, limit }, { groupId, timezone, now: asOf }).total) throw new Error('platform_task_pages_unread')
              }
              await reply(decision, sessionId); submitted = true
              return { status: 'accepted' }
            } })
          agentCtx.tools.register({ name: 'platform_schedule_submit', description: '提交原用户交办的一次未来平台事项，由宿主持有普通持久会话并调用原生 schedule。at 必须为含时区偏移的完整日期时间；返回 scheduled 才可确认已安排，expired 应重新判断补报或过期静默。无需业务任务。',
            parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, prompt: { type: 'string', minLength: 1, maxLength: 8000 }, at: { type: 'string' } }, required: ['title', 'prompt', 'at'], additionalProperties: false }, output,
            execute: (args, exec) => {
              assert(exec)
              return schedules.submit({ groupId, requestId, messageId: message.messageId, messageVersion: message.messageVersion, unitId: unit.unitId, unitRevision: unit.unitRevision, timezone }, args)
            } })
          agentCtx.on('agent/pre-step', (_event, next) => submitted || !current(groupId, message, unit) ? { kind: 'reject' } : next())
          agentCtx.systemPrompt.section({ name: 'dingtalk-platform', order: 120, text: `你在独立的 Agent 平台会话中，已通过宿主正式权限预设选择 danger-full-access。插件不额外限制工具；使用宿主实际提供的工具，仍遵守宿主权限、安全策略和用户授权。只处理当前 source unit，不处理同消息其他业务事项，不为平台问询或定时汇报创建业务任务。查询本群任务状态与历史完成列表时先调用 platform_task_query 获取事实；跨页使用 nextCall 读全后答复。日期以 ${timezone} 为准，当前快照 ${new Date(asOf).toISOString()}（查询工具返回本地日期范围），答复注明范围、时区和快照时刻，不得假称拥有其他群数据。用 platform_reply_submit 显式提交答复；自然语言输出不会发送。零结果应说明当前范围没有记录，不能编造。
时间型事项须结合原消息时间、用户明确的时区（未另行指定时使用上述群时区）和实际执行时刻重新核对目标。一次未来请求调用 platform_schedule_submit，由宿主沿原生 schedule 服务接纳，当前子会话直接调用 schedule_create 会被宿主拒绝。确认真实创建成功后才能承诺已安排，立即确认不等于已完成定时汇报。目标时间已过时，不得照原值创建过去的 schedule，也不得擅自顺延明天。仍有价值的状态汇报补报一次并注明实际时间和延迟；失去意义的定点提醒可记为过期不打扰。只有不确定且会影响执行时才澄清，不统一丢弃或立即执行所有过期事项。` })
          agentCtx.systemPrompt.section({ name: 'dingtalk-group-reply', order: 119, text: groupReplyInstructions })
          agentCtx.systemPrompt.section({ name: 'dingtalk-notification', order: 121, text: groupNotificationInstructions })
        },
      })
      handles.add(handle)
      nameSession(ctx, handle.agent.session, 'platform', '职责内Agent平台相关')
      const text = [...unit.sourceRanges, ...(unit.contextRanges ?? [])].map(range => range.quote).join('\n')
      handle.agent.steer(Object.freeze({ id: requestId, role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: `[AGENT_PLATFORM_QUERY]\n${JSON.stringify({ requestId, groupId, messageId: message.messageId, unitId: unit.unitId, text, notificationContext: platformNotificationContext(store.getGroup(groupId), message), timezone, messageTime: message.occurredAt ?? message.timestamp ?? null, asOf: new Date(asOf).toISOString() })}` }] }))
      await handle.agent.whenIdle()
      if (!submitted && current(groupId, message, unit)) throw new Error('platform_query_no_reply')
    } finally { if (handle) { await handle.dispose(); handles.delete(handle) } }
  }
  function schedule(groupId) {
    if (closed) return
    for (const message of store.getGroup(groupId)?.messages ?? []) {
      if (message.routingStatus !== 'routed') continue
      for (const unit of activeFixedUnits(message)) {
        const id = fixedUnitRequestId(groupId, message, unit)
        if (flights.has(id)) continue
        const work = Promise.resolve().then(() => process(groupId, message, unit)).catch(error => {
          if (error.message === 'fixed_topic_source_stale' && !current(groupId, message, unit)) return
          return onError(groupId, error)
        }).finally(() => flights.delete(id))
        flights.set(id, work)
      }
    }
  }
  return { schedule, async whenIdle() { while (flights.size) await Promise.all([...flights.values()]) },
    async close() { closed = true; for (const handle of handles) handle.agent.cancel({ kind: 'user' }); await Promise.all([...flights.values()]); await schedules.close() } }
}
