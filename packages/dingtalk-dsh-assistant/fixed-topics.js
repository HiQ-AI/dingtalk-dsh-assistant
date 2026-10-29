import { stableId } from './topic-model.js'

export const FIXED_TOPICS = Object.freeze([
  { topicId: 'out-of-scope', title: '职责外话题' },
  { topicId: 'agent-platform', title: '职责内Agent平台相关' },
])
export const fixedTopicIds = FIXED_TOPICS.map(topic => topic.topicId)
// Separate, durable fixed-category registry. These are never business Topics.
export function ensureFixedTopics(group) {
  const fixedTopics = FIXED_TOPICS.map(topic => ({ ...topic, fixed: true,
    createdAt: group.fixedTopics?.find(item => item.topicId === topic.topicId)?.createdAt ?? new Date().toISOString() }))
  return JSON.stringify(group.fixedTopics) === JSON.stringify(fixedTopics) ? group : { ...group, fixedTopics }
}
export const fixedTopicInstructions = '先按群职责语义判断每个 source unit。职责外事项使用 fixedTopic="out-of-scope"（职责外话题）；Agent 平台整体查询使用 fixedTopic="agent-platform"（职责内Agent平台相关），如当前执行中任务、昨天完成的任务。固定类别的 topics=[]，不创建同名业务 Topic，不参与合并或关闭。具体业务进展如“UPR导入修好了吗”仍关联原业务 Topic；普通业务保持原流程。混合消息分别拆 unit，不得吞掉同消息的业务诉求。固定类别仍提供完整 sourceRefs 和 reason。职责外是否回复由 Host 按真实 @ 元数据决定，路由不生成答复；平台类别由独立只读会话回答，不委派业务 Task。'
export const fixedUnitRequestId = (groupId, message, unit) => stableId('fixed-topic', JSON.stringify([groupId, message.messageId, message.messageVersion, unit.unitId, unit.unitRevision, unit.fixedTopic]))
export const activeFixedUnits = message => (message.units ?? []).filter(unit => unit.fixedTopic && !unit.fixedTopicHandledAt
  && message.activeUnitRefs?.some(ref => ref.unitId === unit.unitId && ref.unitRevision === unit.unitRevision))
export const manuallySettled = message => message.routingStatus === 'routed' && message.activeUnitRefs?.length > 0
  && message.activeUnitRefs.every(ref => message.units?.some(unit => unit.unitId === ref.unitId && unit.unitRevision === ref.unitRevision && unit.manualCorrection && unit.fixedTopicHandledAt))

export function dateInZone(instant, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
export function platformTaskPage(tasks, { state = 'all', day, offset = 0, limit = 50 } = {}, { groupId, timezone, now = Date.now() }) {
  if (!['all', 'running', 'completed'].includes(state) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('platform_task_query_invalid')
  const today = dateInZone(now, timezone)
  const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10)
  const date = day === 'yesterday' ? yesterday : day === 'today' ? today : day
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date)) throw new Error('platform_task_date_invalid')
  const matched = tasks.filter(task => task.groupId === groupId && (state === 'all' || task.state === state)
    && (!date || task.completedAt && dateInZone(task.completedAt, timezone) === date))
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
  const items = matched.slice(offset, offset + limit).map(({ taskId, title, state, completedAt, archivedAt }) => ({ taskId, title, state, completedAt: completedAt ?? null, archived: !!archivedAt }))
  const nextOffset = offset + items.length, hasMore = nextOffset < matched.length
  return { items, total: matched.length, offset, limit, nextOffset, hasMore, timezone, asOf: new Date(now).toISOString(),
    range: date ? { localDate: date, startInclusive: date + ' 00:00:00', endExclusive: new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10) + ' 00:00:00', timezone } : null,
    nextCall: hasMore ? { name: 'platform_task_query', arguments: { state, ...(day ? { day } : {}), offset: nextOffset, limit } } : null }
}
