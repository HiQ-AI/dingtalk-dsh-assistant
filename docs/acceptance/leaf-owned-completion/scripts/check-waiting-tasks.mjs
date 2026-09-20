#!/usr/bin/env node

const args = process.argv.slice(2)
if (args[0] !== '--check' || args.some((arg, index) => index > 0 && arg !== '--base-url' && args[index - 1] !== '--base-url')) {
  console.error('用法: node check-waiting-tasks.mjs --check [--base-url http://127.0.0.1:18998]')
  process.exitCode = 2
} else {
  const index = args.indexOf('--base-url')
  const baseUrl = index < 0 ? 'http://127.0.0.1:18998' : args[index + 1]
  if (!baseUrl || !/^https?:\/\/[^/]+$/u.test(baseUrl)) throw new Error('base-url 必须是无路径的 HTTP 地址')
  const response = await fetch(`${baseUrl}/state/tasks`)
  if (!response.ok) throw new Error(`读取任务失败: HTTP ${response.status}`)
  const tasks = await response.json()
  if (!Array.isArray(tasks)) throw new Error('任务列表格式异常')
  const candidates = tasks.filter(task => task.state === 'waiting').map(task => ({
    taskId: task.taskId,
    title: task.title,
    inputVersion: task.inputVersion,
    runSequence: task.runSequence,
    waitingKind: task.waitingKind,
    resultKind: task.result?.waitingKind,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    stageTasks: task.stageTasks,
    resultSummary: task.result?.summary,
  }))
  console.log(JSON.stringify({ mode: 'check', totalTasks: tasks.length, waitingCandidates: candidates }, null, 2))
}
