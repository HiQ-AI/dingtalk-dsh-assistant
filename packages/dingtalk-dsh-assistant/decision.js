import { z } from 'zod'

const runPlan = { acceptanceCriteria: z.array(z.string().min(1)).optional(), stageTasks: z.array(z.string().min(1)).optional() }
const taskProposal = z.strictObject({ kind: z.literal('task-proposal'), title: z.string().min(1).max(120), objective: z.string().min(1) })
const newTask = z.strictObject({ kind: z.literal('new-task'), title: z.string().min(1).max(120), objective: z.string().min(1), acceptanceCriteria: z.array(z.string().min(1)).min(1), stageTasks: z.array(z.string().min(1)).optional() })
const taskContext = z.strictObject({ kind: z.literal('task-context'), taskId: z.string().min(1), context: z.string().min(1), objective: z.string().min(1).optional(), ...runPlan })
const taskReopen = z.strictObject({ kind: z.literal('task-reopen'), taskId: z.string().min(1), context: z.string().min(1), objective: z.string().min(1).optional(), ...runPlan })
const taskAction = z.discriminatedUnion('kind', [taskProposal, newTask, taskContext, taskReopen])
export const groupDecisionSchema = z.union([
  z.strictObject({ actions: z.tuple([]), reply: z.string().min(1) }),
  z.strictObject({ actions: z.tuple([]), reason: z.string().min(1) }),
  z.strictObject({ actions: z.array(taskAction).min(1), reply: z.string() }),
])

function mainMessageTime(value) {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value !== 'string' || value.trim() === '') return '未知'
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') : value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString()
}

export function buildDecisionPrompt({ messageId, message, senderName, senderOpenDingTalkId, occurredAt, quotedMessage, mediaUnavailable }) {
  const messageBlock = [
    `消息唯一标识：${messageId ?? '未知'}`,
    `发送者：${senderName ?? '未知'}`,
    `发送者OpenDingTalkId：${senderOpenDingTalkId ?? '未知'}`,
    `时间：${mainMessageTime(occurredAt)}`,
    `内容：${message}`,
  ]
  if (quotedMessage?.messageId) messageBlock.push(`引用消息ID：${quotedMessage.messageId}`)
  if (Array.isArray(mediaUnavailable) && mediaUnavailable.length > 0) messageBlock.push(`附件读取异常：${mediaUnavailable.join('；')}。不得仅因附件暂不可读而断言消息与职责或活动任务无关；如果这些附件承载任务所需信息，必须先回答并明确告知对方哪些信息未获取到，不得创建、续接或重开任务。`)
  return [
    '[GROUP_DECISION]',
    '',
    ...messageBlock,
  ].join('\n')
}

export function buildLeafSourceEnvelope({ messageId, message, senderName, senderOpenDingTalkId, occurredAt, quotedMessage, mediaUnavailable }) {
  const lines = [
    '[TASK_SOURCE_EVIDENCE]',
    `消息ID：${messageId ?? '未知'}`,
    `发送者：${senderName ?? '未知'}`,
    `发送者OpenDingTalkId：${senderOpenDingTalkId ?? '未知'}`,
    `时间：${mainMessageTime(occurredAt)}`,
  ]
  if (quotedMessage?.messageId) lines.push(`引用消息ID：${quotedMessage.messageId}`)
  lines.push('', '原始消息：', String(message ?? ''))
  if (Array.isArray(mediaUnavailable) && mediaUnavailable.length > 0) lines.push('', `附件读取异常：${mediaUnavailable.join('；')}`)
  lines.push('', '以上是来源消息，不是已经核验的根因、完成状态或实施方案。请基于当前代码、运行态和工具证据独立判断；动作授权不得超出原始消息。')
  return lines.join('\n')
}

export function isExplicitAgentDirection(message, names = []) {
  if (/^\s*cc\s*:/iu.test(message)) return true
  return names.filter((name) => typeof name === 'string' && name.trim() !== '').some((name) => {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`@?${escaped}(?:\\([^)]*\\))?`, 'u').test(message)
  })
}

export function shouldRecheckTaskAssociation({ activeTaskCount, hasImage, previousMessage, occurredAt }) {
  if (activeTaskCount < 1) return false
  if (hasImage) return true
  if (!previousMessage?.text?.includes('[图片消息]')) return false
  const currentTime = new Date(occurredAt).valueOf()
  const previousTime = new Date(previousMessage.occurredAt).valueOf()
  return Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime >= previousTime && currentTime - previousTime <= 2 * 60 * 1000
}

export function blockTaskDecisionForUnavailableMedia(decision, mediaUnavailable) {
  const unavailable = Array.isArray(mediaUnavailable) ? mediaUnavailable.map((item) => String(item).trim()).filter(Boolean) : []
  if (unavailable.length === 0 || !decision.actions.some((action) => ['new-task', 'task-context', 'task-reopen'].includes(action.kind))) return decision
  return { actions: [], reply: `我没能获取到以下任务信息：${unavailable.join('；')}。请重新发送可访问的内容，信息补齐后我再开始处理。` }
}

export function parseGroupDecision(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('group_decision_invalid_json', { cause: error })
  }
  const result = groupDecisionSchema.safeParse(value)
  if (!result.success) throw new Error(`group_decision_invalid_schema:${result.error.issues.map((issue) => issue.path.join('.')).join(',')}`)
  return result.data
}
