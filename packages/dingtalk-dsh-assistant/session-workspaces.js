import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export const sessionPurposes = Object.freeze({
  answer: '消息问答', owner: '任务负责', execution: '任务执行', resident: '群聊常驻',
  route: '消息归类', decision: '话题决策', review: '结果审阅',
})

/** 目录按插件真实创建职责分类；配置根和指引来自调用方，不携带本机身份。 */
export async function sessionWorkspace(root, purpose) {
  if (!isAbsolute(root ?? '') || !Object.hasOwn(sessionPurposes, purpose)) throw new Error('SESSION_WORKSPACE_INVALID')
  const base = await realpath(root)
  const within = path => { const rel = relative(base, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
  const container = join(base, 'session-workspaces')
  await mkdir(container, { recursive: true })
  if (!within(await realpath(container))) throw new Error('SESSION_WORKSPACE_OUTSIDE_ROOT')
  const directory = join(container, sessionPurposes[purpose])
  await mkdir(directory, { recursive: true })
  const resolved = await realpath(directory)
  if (!within(resolved)) throw new Error('SESSION_WORKSPACE_OUTSIDE_ROOT')
  return resolved
}

export function sessionTitle(purpose, subject = '') {
  const label = sessionPurposes[purpose]
  if (!label) throw new Error('SESSION_PURPOSE_INVALID')
  const text = String(subject).replace(/https?:\/\/\S+|[A-Z]:[\\/]\S+/gi, '')
    .replace(/(?:task|session|run|node|topic|unit|msg|answer|coord)-[\w:-]+|\b[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\b|\b[a-f\d]{24,}\b/gi, '')
    .replace(/(?:taskId|sessionId|runId|任务编号|会话编号)\s*[:：=]?\s*\S+/gi, '')
    .replace(/\s+/g, ' ').trim().split(/[\n。；;]/)[0]
  const heading = [...text].slice(0, 28).join('').replace(/[\s，,:：-]+$/, '')
  return heading ? `${heading} · ${label}` : label
}

/** 原生标题服务拥有持久化及自动标题的取消；没有该能力的 Host 不伪造标题事件。 */
export function nameSession(ctx, session, purpose, subject) {
  const titles = ctx.get?.('sessionTitle') ?? ctx.sessionTitle
  if (titles) titles.rename(session, sessionTitle(purpose, subject))
}
