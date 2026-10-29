import { randomUUID } from 'node:crypto'
import { activeFixedUnits, fixedUnitRequestId, platformTaskPage } from './fixed-topics.js'
import { sessionWorkspace, nameSession } from './session-workspaces.js'
import { groupReplyInstructions } from './group-message.js'

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const allowed = ['platform_task_query', 'platform_reply_submit']

// Fixed routes have no business Topic, Owner, or execution. Reply preparation uses the existing outbox.
export function createFixedTopicHandler({ ctx, store, legacy, root, models, appendOutbox, readTasks, readMentioned, onSettled = () => {}, onError = () => {}, now = Date.now }) {
  const flights = new Map(), handles = new Set()
  let closed = false
  const current = (groupId, message, unit) => !closed && store.getGroup(groupId)?.messages.some(item => item.messageId === message.messageId
    && item.messageVersion === message.messageVersion && activeFixedUnits(item).some(value => value.unitId === unit.unitId && value.unitRevision === unit.unitRevision))
  async function process(groupId, message, unit) {
    const requestId = fixedUnitRequestId(groupId, message, unit)
    const previous = store.getGroup(groupId).outbox.find(item => item.outboundId === requestId)
    const finish = async () => { await store.markFixedTopicHandled({ groupId, messageId: message.messageId, messageVersion: message.messageVersion, unitId: unit.unitId, unitRevision: unit.unitRevision }); onSettled(groupId) }
    const reply = async text => {
      if (!current(groupId, message, unit)) throw new Error('fixed_topic_source_stale')
      if (!message.senderOpenDingTalkId) throw new Error('fixed_topic_reply_actor_required')
      await appendOutbox({ groupId, outboundId: requestId, sourceMessageId: requestId, topicRefs: [],
        preflight: () => { if (!current(groupId, message, unit)) throw new Error('fixed_topic_source_stale') },
        matterSourceMessageIds: [message.messageId], matterUnitRefs: [{ unitId: unit.unitId, unitRevision: unit.unitRevision }],
        text, replyKind: 'substantive', replyToMessageId: message.messageId, replyToSenderOpenDingTalkId: message.senderOpenDingTalkId,
        atOpenDingTalkIds: [message.senderOpenDingTalkId], taskIds: [] })
      await finish()
    }
    // Reconcile the same frozen reply after a crash between outbox/notification preparation and unit settlement.
    if (previous) { await reply(previous.text); return }
    if (unit.fixedTopic === 'out-of-scope') {
      if (message.mentionedAgent === true || message.mentionedAgent === undefined && readMentioned && await readMentioned(groupId, message)) await reply('这个不是我负责哦')
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
        setup: async agentCtx => {
          const presets = agentCtx.get('agentPresets')
          if (!presets) throw new Error('agent_presets_required')
          const preset = await presets.mount(agentCtx, agentPreset)
          if (preset?.id !== undefined && preset.id !== agentPreset) throw new Error('platform_agent_preset_invalid')
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
          agentCtx.tools.register({ name: 'platform_reply_submit', description: '提交平台问询答复并通过原消息回复；没有任务管理权限。',
            parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false }, output,
            execute: async ({ text }, exec) => {
              assert(exec)
              if (submitted) return { status: 'accepted' }
              if (typeof text !== 'string' || !text.trim()) throw new Error('platform_reply_empty')
              // Every query made for this answer must have consumed its full result, including empty lists.
              for (const [key, consumed] of pages) {
                const [state, day, limit] = JSON.parse(key)
                if (consumed < platformTaskPage(tasks, { state, day: day ?? undefined, limit }, { groupId, timezone, now: asOf }).total) throw new Error('platform_task_pages_unread')
              }
              await reply(text.trim()); submitted = true
              return { status: 'accepted' }
            } })
          agentCtx.tools.restrict({ allow: allowed })
          agentCtx.tools.guard(execution => allowed.includes(execution.name) ? undefined : 'platform_query_readonly')
          agentCtx.on('agent/pre-step', (_event, next) => submitted || !current(groupId, message, unit) ? { kind: 'reject' } : next())
          agentCtx.systemPrompt.section({ name: 'dingtalk-platform-readonly', order: 120, text: `你在独立的 Agent 平台只读问询会话中。只回答当前 source unit，不处理同消息的其他业务事项。可查询本群任务状态与历史完成列表，必须先调用 platform_task_query 获取事实；跨页使用 nextCall 读全后答复。日期以 ${timezone} 为准，今天 ${new Date(asOf).toISOString()}（查询工具返回本地日期范围），答复注明范围、时区和快照时刻。不得假称拥有其他群数据。没有创建、补充、唤醒、取消、完成或其他任务管理权限；遇修改请求明确说明这里只能查询，不能执行管理操作。用 platform_reply_submit 显式提交简短答复；自然语言输出不会发送。零结果应明确说当前范围没有记录，不能编造。` })
          agentCtx.systemPrompt.section({ name: 'dingtalk-group-reply', order: 119, text: groupReplyInstructions })
        },
      })
      handles.add(handle)
      nameSession(ctx, handle.agent.session, 'platform', '职责内Agent平台相关')
      const text = [...unit.sourceRanges, ...(unit.contextRanges ?? [])].map(range => range.quote).join('\n')
      handle.agent.steer(Object.freeze({ id: requestId, role: 'user', source: { kind: 'coordinator' }, content: [{ type: 'text', text: `[AGENT_PLATFORM_QUERY]\n${JSON.stringify({ requestId, groupId, messageId: message.messageId, unitId: unit.unitId, text, timezone, asOf: new Date(asOf).toISOString() })}` }] }))
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
    async close() { closed = true; for (const handle of handles) handle.agent.cancel({ kind: 'user' }); await Promise.all([...flights.values()]) } }
}
