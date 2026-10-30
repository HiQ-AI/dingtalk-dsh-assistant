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
export const fixedTopicInstructions = '在同一次Route判断中结合本群职责与共同业务事项确定归属，复用旧Topic前也必须核对职责范围。旧Topic的标题、摘要或引用命中只提供背景，不能覆盖职责判断；历史误归入普通Topic的职责外协作，本次直接归fixedTopic="out-of-scope"，不沿旧Topic再调用普通业务TopicDecision判断是否职责外。recentMessages只是有界的前序对话背景，不是本批待路由来源，也不代表都属于同一事项；结合明确引用、本批上下文和相关近期原文理解“OK”“试试”“可以了”等短句，不以关键词过滤或凭短句猜事项。既往职责外分类不永久继承；出现新的职责内技术问题时重新判断，保留其业务Topic归属。结合原消息、引用、近期上下文、本群职责及相关任务状态，先判断每个 source unit 的事项归属，再独立判断本助手是否需要动作或回复。fixedTopic="out-of-scope"（职责外话题）只用于本群职责之外的事项，不能把“未交给本助手”当成“职责外”。职责内业务消息即使明确指定其他负责人、由其他助手发送状态通知，或仅引用同事信息，也应保留在对应业务 Topic；是否已有本助手 Task 不是保留业务上下文的前提。优先复用同一业务目标的原 Topic，不因换了负责人拆走上下文，不因 @ 别人就丢弃原文。明确他人负责且未要求本助手参与时，后续 Topic Decision 用 actions:[]、reason 和 topicUpdate.summary 保存事实，省略 reply，不创建或唤醒任务、不追问；他人处理进展只作为其报告的业务事实，不能自动作为本助手任务完成证据。信息补充本身不授权重做或另建任务。同时向本助手提出的诉求仍按原文处理。人员别名用于准确理解谁被提到，不改变事项归属。仅真正超出职责且明确向本助手求助的 unit 可设 outOfScopeHelp=true，Host 再按真实 @ 元数据决定是否简短说明职责边界；职责外讨论和明确无需助手回复的纠正省略此字段并沉默。Agent 平台整体查询使用 fixedTopic="agent-platform"（职责内Agent平台相关），如当前执行中任务、昨天完成的任务；Cortex/Claude 等技术词本身不决定分类，同事间职责外工具账号讨论仍归职责外话题。固定类别的 topics=[]，不创建同名业务 Topic，不参与合并或关闭。具体业务进展如“UPR导入修好了吗”仍关联原业务 Topic；混合消息分别拆 unit，不得吞掉同消息的业务上下文。固定类别仍提供完整 sourceRefs 和 reason。路由不生成答复；平台类别由独立只读会话回答，不委派业务 Task。'
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
