import { z } from 'zod'

const answer = z.strictObject({ kind: z.literal('answer'), reply: z.string().min(1) })
const newTask = z.strictObject({ kind: z.literal('new-task'), objective: z.string().min(1), reply: z.string().min(1) })
const taskContext = z.strictObject({ kind: z.literal('task-context'), taskId: z.string().min(1), context: z.string().min(1), reply: z.string() })
const taskReopen = z.strictObject({ kind: z.literal('task-reopen'), taskId: z.string().min(1), context: z.string().min(1), reply: z.string().min(1) })
const ignore = z.strictObject({ kind: z.literal('ignore'), reason: z.string().min(1) })
export const groupDecisionSchema = z.discriminatedUnion('kind', [answer, newTask, taskContext, taskReopen, ignore])

function mainMessageTime(value) {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value !== 'string' || value.trim() === '') return '未知'
  const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') : value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString()
}

export function buildDecisionPrompt({ sequence = 1, message, senderName, senderOpenDingTalkId, occurredAt, quotedMessage, mediaUnavailable }) {
  const messageBlock = [
    `消息 ${sequence}`,
    `发送者：${senderName ?? '未知'}`,
    `发送者OpenDingTalkId：${senderOpenDingTalkId ?? '未知'}`,
    `时间：${mainMessageTime(occurredAt)}`,
    `内容：${message}`,
  ]
  if (quotedMessage?.messageId) messageBlock.push(`引用消息ID：${quotedMessage.messageId}`)
  if (Array.isArray(mediaUnavailable) && mediaUnavailable.length > 0) messageBlock.push(`附件读取异常：${mediaUnavailable.join('；')}。不得仅因附件暂不可读而断言消息与职责或活动任务无关。`)
  return [
    '[GROUP_DECISION]',
    '',
    ...messageBlock,
  ].join('\n')
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
