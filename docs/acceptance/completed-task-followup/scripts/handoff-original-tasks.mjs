import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const apply = process.argv.includes('--apply')
if (!apply && !process.argv.includes('--check')) throw Error('需要 --check 或 --apply')
const db = new DatabaseSync('D:/baibu-agent/.dsh/task-sessions.sqlite', { readOnly: true })
const aggregate = 'task-4c394da47b32a2ef77383dfe6555bc46'
const inventory = `D:/baibu-agent/tasks/${aggregate}/docs/acceptance/pr-review-inventory`
const output = resolve('docs/tmp/pr225-handoff')
const mappings = [
  ['task-4c4780a541c5ea7c51024975de5f121d', 353, 'UAT2；已有集成 PR391、流水线289和后续镜像更新证据。另一任务“最小集成审核撤回并部署UAT2”不另行重开，共享PR由本任务唯一续办。'],
  ['task-7c7b8c0d7287a6bd0de4e2a2519ba764', 395, 'UAT2；已有集成PR397。'],
  ['task-1a0c02d986c338f4a03a0a1d12113e5c', 396, 'UAT2；已有集成PR398及49项定向测试。'],
  ['task-f82e8092525f9fdffb363eb35e62f95b', 356, 'UAT2；已有集成PR399。'],
  ['task-f9cd3e8a3f86ae06a30ffe38d31bd2ba', 402, 'UAT2；已有集成PR403。'],
  ['task-fd754e63922f99796598df3048c7b6e9', 405, '原任务未部署，已有15项测试和9c6cbc0提交。此次新增适用评论修订及对应UAT提测授权；先核对真实目标环境，不能猜测目标或重做已完成性能/import更正。'],
]
const getTask = id => JSON.parse(db.prepare('select body from dynamic_tasks where id=?').get(id).body)
const rows = table => db.prepare(`select body from ${table}`).all().map(r => JSON.parse(r.body))
const total = getTask(aggregate)
if (!total.drained || !['active', 'cancelled'].includes(total.status)) throw Error('总任务状态发生变化')
if (rows('dynamic_executions').some(e => e.taskId === aggregate && !e.drained)) throw Error('总执行未排空')
if (rows('dynamic_operations').some(o => o.taskId === aggregate && !['succeeded', 'failed', 'cancelled'].includes(o.state))) throw Error('存在未结算操作')
const plan = []
for (const [id, pr, target] of mappings) {
  const task = getTask(id)
  if (task.status !== 'completed' || !task.drained || task.archivedAt) throw Error(`原任务不满足重开前置：${id}`)
  const snapshot = JSON.parse(await readFile(`${inventory}/pr-${pr}.json`, 'utf8')).data.repository.pullRequest
  plan.push({ id, pr, title: task.title, sessionId: task.sessionId, runSequence: task.runSequence, target, head: snapshot.headRefOid,
    body: { requestId: `pr225-handoff-${pr}-20261020`, expectedRequirementRevision: task.requirementRevision,
      expectedControlRevision: task.controlRevision,
      context: `用户明确要求：仅当前看板原任务关联的未合并 dataset PR，逐个核验新审查评论、适用则修订并重新提测对应UAT。现将总任务 ${aggregate} 的剩余增量交回本原任务续办，保留原 task/session、有效验证和已成功效果。\n范围仅原交付 PR #${pr} https://github.com/HiQ-AI/dataset/pull/${pr} 内属于本事项的评论。总任务已核查72次工具调用，唯一执行为只读调查；只写调查材料，无代码修改、提交推送或部署，执行因provider网络错误终止。不要重跑其宽范围历史PR调查。\n复用材料：${inventory}/pr-${pr}.json、inventory.json、code-evidence.txt、worktrees.txt、remote-heads.txt；快照head=${snapshot.headRefOid}。先读材料并现场核对PR最新head/状态/评论是否仍未处理；已合并、已处理或不适用则说明证据并结束，不制造修改或重复提测。\n既有交付：${target} 原completion及执行收据仍有效，不重复执行其成功步骤。只有本次必要修订才新增定向测试、原开发PR交付和对应UAT集成；禁止合并main、生产发布、无关PR/代码、真实业务测试写入和越界全仓测试。历史未知共享效果仍保留，不宣称已消除。\n6个原任务共享同一dataset/UAT资源，必须串行：本轮每个task_delegate均使用resourceKeys=["dataset-review-uat2"]，覆盖修订至提测读回，避免同时集成或覆盖同一UAT。总任务已停止后续执行，不另建总任务。无需重复申请本次已明确授权的适用修订及UAT提测；真实缺少目标信息时才报告具体缺口。` } })
}
if (!apply) {
  console.log(JSON.stringify({ checkOnly: true, writes: 0, aggregate: { id: aggregate, status: total.status, controlRevision: total.controlRevision },
    tasks: plan.map(({ body, ...item }) => item) }, null, 2))
} else {
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/plan.json`, JSON.stringify(plan, null, 2))
  async function post(path, body) {
    const response = await fetch(`http://127.0.0.1:18998${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw Error(`${path}: ${response.status} ${JSON.stringify(result)}`)
    return result
  }
  if (total.status !== 'cancelled') await post(`/tasks/${aggregate}/cancel`, { requestId: 'pr225-stop-aggregate-20261020',
    expectedControlRevision: total.controlRevision, reason: '已核对唯一只读调查执行及72次工具调用，仅调查文件落盘，无代码修改/提交推送/提测；停止本总任务后续执行，剩余工作交回当前看板对应原任务，避免重复处理。历史证据及失败收据保留。' })
  if (getTask(aggregate).status !== 'cancelled') throw Error('总任务取消独立回读失败')
  for (const item of plan) {
    await post(`/tasks/${item.id}/reopen`, item.body)
    const actual = getTask(item.id)
    if (actual.sessionId !== item.sessionId || actual.runSequence !== item.runSequence + 1 || !actual.request.includes(item.body.context)) throw Error(`重开独立回读失败：${item.id}`)
    await writeFile(`${output}/${item.pr}.json`, JSON.stringify({ taskId: item.id, sessionId: actual.sessionId, runSequence: actual.runSequence, requirementRevision: actual.requirementRevision, status: actual.status }, null, 2))
    console.log(JSON.stringify({ pr: item.pr, taskId: item.id, status: actual.status, sessionPreserved: true }))
  }
}
db.close()
