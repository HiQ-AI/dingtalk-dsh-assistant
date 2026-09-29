import { mkdir, realpath, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep, dirname, resolve } from 'node:path'

const taskSegment = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  && !/[.]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)

/** 只由受信任务身份计算路径，标题及消息文本不参与目录命名。 */
export function taskFilePath(root, logicalTaskId, area, ...segments) {
  if (!isAbsolute(root ?? '') || !taskSegment(logicalTaskId) || !['work', 'tmp', 'outputs'].includes(area)
    || segments.some(value => !taskSegment(value))) throw new Error('TASK_DIRECTORY_INVALID')
  return join(resolve(root), 'tasks', logicalTaskId, area, ...segments)
}

/** 写前逐层核对，避免先 mkdir 穿过已有 junction 再发现越界。 */
export async function checkedTaskDirectory(path, create = false) {
  if (!isAbsolute(path ?? '')) throw new Error('TASK_DIRECTORY_INVALID')
  const parent = dirname(path)
  if (parent !== path) await checkedTaskDirectory(parent, create)
  let entry = await lstat(path).catch(error => { if (create && error.code === 'ENOENT') return null; throw error })
  if (!entry) {
    await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error })
    entry = await lstat(path)
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || relative(path, await realpath(path)) !== '')
    throw new Error('TASK_DIRECTORY_OUTSIDE_ROOT')
  return path
}

export async function taskDirectories(workspaceRoot, logicalTaskId) {
  const work = taskFilePath(workspaceRoot, logicalTaskId, 'work')
  const tmp = taskFilePath(workspaceRoot, logicalTaskId, 'tmp')
  const outputs = taskFilePath(workspaceRoot, logicalTaskId, 'outputs')
  for (const path of [work, tmp, outputs]) await checkedTaskDirectory(path, true)
  return { logicalTaskId, root: dirname(work), work, tmp, outputs }
}

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
