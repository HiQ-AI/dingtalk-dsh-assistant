import { mkdir, realpath, lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep, dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const taskSegment = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
  && !/[.]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)

/** 只由受信任务身份计算路径，标题及消息文本不参与目录命名。 */
export function taskFilePath(root, logicalTaskId, area, ...segments) {
  if (!isAbsolute(root ?? '') || !taskSegment(logicalTaskId) || !['materials', 'work', 'tmp', 'outputs'].includes(area)
    || segments.some(value => !taskSegment(value))) throw new Error('TASK_DIRECTORY_INVALID')
  return join(resolve(root), 'tasks', logicalTaskId, area, ...segments)
}

/** 写前逐层核对，避免先 mkdir 穿过已有 junction 再发现越界。 */
export async function checkedTaskDirectory(path, create = false) {
  if (!isAbsolute(path ?? '')) throw new Error('TASK_DIRECTORY_INVALID')
  async function inspect(current) {
    const parent = dirname(current)
    if (parent !== current) await inspect(parent)
    let entry = await lstat(current).catch(error => { if (create && error.code === 'ENOENT') return null; throw error })
    if (!entry) {
      // 创建前仍解析真实父链；已有目录只在末端解析一次，避免逐祖先重复解析。
      if (relative(parent, await realpath(parent)) !== '') throw new Error('TASK_DIRECTORY_OUTSIDE_ROOT')
      await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error })
      entry = await lstat(current)
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('TASK_DIRECTORY_OUTSIDE_ROOT')
  }
  await inspect(path)
  if (relative(path, await realpath(path)) !== '') throw new Error('TASK_DIRECTORY_OUTSIDE_ROOT')
  return path
}

export async function taskDirectories(workspaceRoot, logicalTaskId) {
  const materials = taskFilePath(workspaceRoot, logicalTaskId, 'materials')
  const work = taskFilePath(workspaceRoot, logicalTaskId, 'work')
  const tmp = taskFilePath(workspaceRoot, logicalTaskId, 'tmp')
  const outputs = taskFilePath(workspaceRoot, logicalTaskId, 'outputs')
  for (const path of [materials, work, tmp, outputs]) await checkedTaskDirectory(path, true)
  return { logicalTaskId, root: dirname(work), materials, work, tmp, outputs }
}

/** A task owns one durable workspace; neither its title nor its model can choose the path. */
export async function taskWorkspace(root, taskId) {
  return (await taskDirectories(root, taskId)).root
}

/** Every execution of a task shares its task's native workspace and runtime directory. */
export async function taskExecutionWorkspace(root, taskId, sessionId) {
  if (!taskSegment(sessionId)) throw new Error('TASK_DIRECTORY_INVALID')
  return taskWorkspace(root, taskId)
}

/** 可再生成的每轮阅读视图；执行账和原生日志仍是事实来源。 */
export function renderExecutionDocument(execution) {
  const identity = Object.fromEntries(['taskId', 'executionId', 'sessionId', 'inputVersion', 'requirementRevision', 'controlRevision']
    .map(key => [key, execution[key]]))
  const quote = value => String(value ?? '').replaceAll('\r\n', '\n').split('\n').map(line => `> ${line}`).join('\n')
  const section = (title, value) => `## ${title}\n\n${quote(value)}\n`
  const list = values => Array.isArray(values) && values.length ? values.map(value => `- ${value}`).join('\n') : '无记录。'
  const sameRound = value => value && ['inputVersion', 'requirementRevision', 'controlRevision'].every(key => value[key] === execution[key])
  const stage = sameRound(execution.stageProgress) ? execution.stageProgress : null
  const result = sameRound(execution.result) ? execution.result : null
  const output = result?.payload?.output
  const feedback = (execution.feedback ?? []).filter(item => item.requirementRevision === execution.requirementRevision
    && item.controlRevision === execution.controlRevision && (!item.sourceExecutionId || item.inputVersion === execution.inputVersion))
  const lines = [
    `<!-- execution-document ${JSON.stringify(identity)} -->`,
    `# 执行文档 · 第 ${execution.inputVersion} 轮\n`,
    'Host 根据持久执行记录生成。执行报告不等于独立核验，状态不等于业务验收；活动只表示报告时的活动。',
    '每次输入续办形成新轮，旧轮文件保留。日常先读本文件；证据缺失、矛盾或异常时，按会话身份读取原始记录。\n',
    section('身份与状态', [...Object.entries(identity).map(([key, value]) => `${key}: ${value}`),
      `executionBackend: ${execution.definition?.executionBackend ?? 'dsh'}`,
      ...(execution.claudeSessionMode ? [`claudeSessionMode: ${execution.claudeSessionMode}`] : []),
      `leaseEpoch: ${execution.leaseEpoch}`, `status: ${execution.status}${execution.status === 'queued' ? '（已安排，待启动）' : ''}`,
      `drained: ${execution.drained === true}`, `cancelRequested: ${execution.cancelRequested === true}`,
      `updatedAt: ${execution.updatedAt ?? '未记录'}`].join('\n')),
    section('本轮小目标', execution.input?.objective || '未记录小目标。'),
    section('交接上下文与范围', execution.input?.context || '未提供交接上下文。'),
    section('本轮计划', stage?.plan || '尚未报告计划，不能从目标或结果推断计划已执行。'),
  ]
  if (execution.claudeSessionMode === 'interactive-team-v1') {
    lines.push(section('原生队友执行文档', `本轮队友的职责、工具事件与状态记录在 outputs/${execution.executionId}/round-${execution.inputVersion}-lease-${execution.leaseEpoch}/。只有实际创建队友后才生成文件；目录不存在不表示已完成。旧轮及旧租约目录保留，不覆盖。`))
  }
  if (stage) {
    lines.push(section('最新阶段报告', `recordedAt: ${stage.recordedAt}\nleaseEpoch: ${stage.leaseEpoch}\nsequence: ${stage.sequence}\n\n${stage.summary}`),
      section('报告时活动', stage.activity || '未报告活动。'), section('阶段证据', list(stage.evidence)))
  } else {
    lines.push(section('最新阶段报告', execution.stageProgress
      ? `本轮尚无阶段报告。保留的报告属于 inputVersion=${execution.stageProgress.inputVersion}、requirementRevision=${execution.stageProgress.requirementRevision}、controlRevision=${execution.stageProgress.controlRevision}，不能作为本轮进展。`
      : '本轮尚无阶段报告。'))
  }
  if (result) {
    lines.push(section('本轮执行结果', `receivedAt: ${result.receivedAt}\nleaseEpoch: ${result.leaseEpoch}\ncurrent: ${result.current}\n\n${output?.summary || '未提交业务结果。'}`))
    if (output) lines.push(section('结果证据', list(output.evidence)), section('交付产物', list(output.artifacts)), section('限制与待处理事项', list(output.limitations)))
    if (result.payload?.error) lines.push(section('执行错误', JSON.stringify(result.payload.error, null, 2)))
  } else lines.push(section('本轮执行结果', '本轮尚无结果；历史轮次的结果不代表本轮已完成。'))
  lines.push(section('资源状态', JSON.stringify(execution.resources ?? { keys: execution.resourceKeys ?? [], state: '未读取' }, null, 2)),
    section('当前有效反馈索引', feedback.length ? feedback.map(item => [
      `messageId: ${item.id}`, item.sourceExecutionId ? `来源: 执行 ${item.sourceExecutionId} / inputVersion=${item.sourceInputVersion} / leaseEpoch=${item.sourceLeaseEpoch}` : '来源: 统筹或当前任务补充',
      `接收: ${item.receivedAt ?? '未记录'}`, `消费: ${item.consumedAt || '尚未消费'}`,
    ].join('\n')).join('\n\n') : '无当前有效反馈。'),
    `反馈消费只证明${execution.definition?.executionBackend === 'claude-code' ? 'Claude CLI 已接纳输入' : '进入模型步骤'}，不证明已经落实；有未消费或存在争议的反馈时，按 messageId 读取原反馈正文。\n`)
  return lines.join('\n')
}

/** 调用方按 executionId 串行读取最新账后发布；每轮只替换自己的完整文件。 */
export async function materializeExecutionDocument(root, execution) {
  const fail = code => { throw Object.assign(new Error(code), { code }) }
  if (!Number.isSafeInteger(execution.inputVersion) || execution.inputVersion < 1 || !taskSegment(execution.sessionId)
    || !Number.isSafeInteger(execution.requirementRevision) || execution.requirementRevision < 1
    || !Number.isSafeInteger(execution.controlRevision) || execution.controlRevision < 1) fail('EXECUTION_DOCUMENT_IDENTITY_INVALID')
  const path = taskFilePath(root, execution.taskId, 'outputs', execution.executionId, `round-${execution.inputVersion}.md`)
  const directory = dirname(path)
  await checkedTaskDirectory(directory, true)
  const expected = Object.fromEntries(['taskId', 'executionId', 'sessionId', 'inputVersion', 'requirementRevision', 'controlRevision'].map(key => [key, execution[key]]))
  const validateIdentity = bytes => {
    let identity
    try { identity = JSON.parse(/^<!-- execution-document (.+) -->\n/.exec(bytes.toString('utf8'))?.[1]) } catch { fail('EXECUTION_DOCUMENT_IDENTITY_INVALID') }
    if (!identity || Object.keys(expected).some(key => identity[key] !== expected[key])) fail('EXECUTION_DOCUMENT_IDENTITY_MISMATCH')
  }
  const readExisting = async () => {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!info) return null
    if (!info.isFile() || info.isSymbolicLink()) fail('EXECUTION_DOCUMENT_PATH_INVALID')
    const bytes = await readFile(path)
    validateIdentity(bytes)
    return bytes
  }
  const bytes = Buffer.from(renderExecutionDocument(execution), 'utf8')
  validateIdentity(bytes)
  const prior = await readExisting()
  const laterRound = (await readdir(directory, { withFileTypes: true })).some(entry => {
    const match = /^round-([1-9]\d*)\.md$/.exec(entry.name)
    return match && Number(match[1]) > execution.inputVersion
  })
  // 新轮出现后，旧轮只能回读，不能从后续输入/结果倒填历史。
  if (laterRound && !prior?.equals(bytes)) fail('EXECUTION_DOCUMENT_ROUND_FROZEN')
  if (!prior?.equals(bytes)) {
    const temporary = join(directory, `.pending-${randomUUID()}`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await checkedTaskDirectory(directory)
      await readExisting()
      await rename(temporary, path)
      if (process.platform !== 'win32') {
        const dir = await open(directory, 'r')
        try { await dir.sync() } finally { await dir.close() }
      }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  await checkedTaskDirectory(directory)
  if (!(await readExisting())?.equals(bytes)) fail('EXECUTION_DOCUMENT_CONTENT_MISMATCH')
  return { path, inputVersion: execution.inputVersion, requirementRevision: execution.requirementRevision, controlRevision: execution.controlRevision,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export const sessionPurposes = Object.freeze({
  answer: '消息问答', owner: '任务负责', execution: '任务执行', resident: '群聊常驻',
  route: '消息归类', decision: '话题决策', review: '结果审阅', coordination: '任务协调',
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

/** One compact name shared by the durable execution, DTO and native session. */
export function executionSessionTitle(execution = {}) {
  // Continuation is not a rename operation, including for legacy English titles.
  if (typeof execution.title === 'string' && execution.title.trim()) return execution.title.trim()
  if (execution.executionId) return sessionTitle('execution', execution.input?.title || execution.key || '').replace(/ · 任务执行$/, '')
  const title = sessionTitle('execution', execution.input?.title ?? '').replace(/ · 任务执行$/, '')
  if (/[\u3400-\u9fff]/u.test(title) && title !== '任务执行') return title
  // No Chinese name supplied: retain the original key naming path, never derive from objective.
  return sessionTitle('execution', execution.key || '').replace(/ · 任务执行$/, '')
}

/** Use the native title service without adding role suffixes to task-owned names. */
export function renameTaskSession(ctx, session, title) {
  const titles = ctx.get?.('sessionTitle') ?? ctx.sessionTitle
  if (titles && typeof title === 'string' && title.trim()) titles.rename(session, title.trim())
}
