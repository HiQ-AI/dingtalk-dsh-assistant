import { z } from 'zod'

export const taskProgressQueryVersion = 'task-progress-query@1'
export const taskProgressQueryDefinition = Object.freeze({ id: 'task-progress-query', label: '查询任务进展', mode: 'built-in', version: taskProgressQueryVersion,
  nodes: [{ id: 'scope', label: '校验范围' }, { id: 'candidates', label: '检索候选' }, { id: 'readback', label: '回读进展' }, { id: 'reply', label: '生成答复' }] })
const itemSchema = z.strictObject({ taskId: z.string().min(1), title: z.string().min(1), status: z.string().min(1), outcome: z.string().nullable(), engine: z.enum(['legacy', 'workflow-v2']), uat2Status: z.string().nullable() })
const stepSchema = z.strictObject({ nodeId: z.enum(['scope', 'candidates', 'readback', 'reply']), status: z.literal('completed'), count: z.number().int().nonnegative() })
export function singleTaskProgressResult(result) {
  if (!result?.taskId || typeof result.reply !== 'string' || !result.reply) throw new Error('TASK_PROGRESS_RESULT_INVALID')
  return { ...result, flow: { id: 'task-progress-query', version: taskProgressQueryVersion,
    steps: ['scope', 'candidates', 'readback', 'reply'].map(nodeId => stepSchema.parse({ nodeId, status: 'completed', count: 1 })) } }
}

/** 消息命令内的一次性平台流程；输出随 command.complete 持久化，不登记业务 Task。 */
export function queryConversationTaskProgress({ queryText, conversationId, actorId, ownerActorId, occurredAt, workflowOrigins, workflowRuns, legacyTasks }) {
  if (typeof queryText !== 'string' || !queryText.trim() || !conversationId || !actorId || !Array.isArray(workflowOrigins) || !Array.isArray(workflowRuns) || !Array.isArray(legacyTasks)) throw new Error('TASK_PROGRESS_QUERY_INPUT_INVALID')
  const steps = [stepSchema.parse({ nodeId: 'scope', status: 'completed', count: 1 })]
  const words = [...new Set((queryText.match(/[\u4e00-\u9fff]+/gu) ?? []).flatMap(part => Array.from({ length: Math.max(0, part.length - 1) }, (_, index) => part.slice(index, index + 2))))]
  const issues = [...queryText.matchAll(/([^，,、；;：:？?]{4,40})的问题/gu)].map(match => match[1].replace(/^.*(?:范围|问句|：)/u, ''))
  const issueWords = issues.map(issue => [...new Set(Array.from({ length: Math.max(0, issue.length - 1) }, (_, index) => issue.slice(index, index + 2)))])
  const asksDelivery = /(?:部署|发布).*(?:UAT|uat|测试环境)|(?:UAT|uat).*(?:部署|发布)/u.test(queryText)
  const candidateTasks = [
    ...workflowOrigins.filter(origin => origin.run.conversationId === conversationId && [origin.run.actorId, ownerActorId].includes(actorId))
      .map(origin => { const run = workflowRuns.find(value => value.taskId === origin.command.args.taskId); return { taskId: origin.command.args.taskId, title: origin.command.args.arguments.objective, objective: origin.command.args.arguments.objective, status: run?.status ?? origin.command.status, outcome: null, engine: 'workflow-v2', uat2Status: null, createdAt: origin.run.createdAt } }),
    ...legacyTasks.filter(task => task.groupId === conversationId).map(task => ({ taskId: task.taskId, title: task.title ?? task.objective ?? task.taskId, objective: task.objective ?? '', status: task.state ?? 'unknown', outcome: task.outcome ?? null, engine: 'legacy', uat2Status: task.result?.delivery?.uat2Status ?? null, createdAt: task.createdAt })),
  ]
  const ranked = candidateTasks.filter(task => (!task.createdAt || task.createdAt < occurredAt)
      && (!asksDelivery || !/(?:仅授权排查|不实施代码|不实施代码、配置|不实施代码、配置或数据)/u.test(task.objective))
      && (!asksDelivery || issueWords.length < 2 || task.outcome && task.outcome !== 'legacy-unknown' || task.uat2Status))
    .map(task => { const title = String(task.title), objective = String(task.objective); const issueScore = issueWords.length >= 2 ? Math.max(...issueWords.map(parts => parts.filter(word => title.includes(word) || objective.includes(word)).length)) : 0; return { task, issueScore, score: words.filter(word => title.includes(word)).length * 3 + words.filter(word => objective.includes(word)).length } })
    .filter(item => item.score >= 3 && (issueWords.length < 2 || item.issueScore >= 3))
    .sort((a, b) => b.issueScore - a.issueScore || b.score - a.score)
  steps.push(stepSchema.parse({ nodeId: 'candidates', status: 'completed', count: ranked.length }))
  const items = ranked.slice(0, 8).map(({ task: { objective: _objective, createdAt: _createdAt, ...task } }) => itemSchema.parse(task))
  steps.push(stepSchema.parse({ nodeId: 'readback', status: 'completed', count: items.length }))
  const reply = items.length ? `${issueWords.length >= 2 ? '按补充的问题清单检索到以下候选任务；业务归属仍需核对：' : '找到以下可能相关的任务，是否属于你说的问题还需结合问题清单确认：'}\n${items.map(item => `${item.title}：${item.status}${item.outcome ? `（${item.outcome}）` : ''}${item.uat2Status ? `；UAT2：${item.uat2Status}` : '；UAT2：未见部署回执'}`).join('\n')}${ranked.length > 8 ? '\n候选超过 8 项，仅显示前 8 项。' : ''}` : '当前没有找到标题或目标明确匹配的本群任务。'
  steps.push(stepSchema.parse({ nodeId: 'reply', status: 'completed', count: items.length }))
  return { status: 'observed', observedAt: new Date().toISOString(), items, coverage: '本群任务标题和目标匹配的候选；未验证候选与提问的业务归属', reply, flow: { id: 'task-progress-query', version: taskProgressQueryVersion, steps } }
}
