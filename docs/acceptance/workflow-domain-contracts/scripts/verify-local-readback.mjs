import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'

// 仅回读固定本机控制面并提交明确非法的入参；不提供合法创建请求。
// 用法：node verify-local-readback.mjs --output <绝对路径的新JSON文件>
const { values } = parseArgs({ options: { output: { type: 'string' } } })
assert.ok(isAbsolute(values.output ?? ''), '--output 必须是绝对路径')
const output = resolve(values.output)
assert.match(output, /\.json$/iu, '--output 必须是新的 JSON 文件')
await access(dirname(output))
await assert.rejects(access(output), error => error.code === 'ENOENT', '禁止覆盖已有输出')

const base = 'http://127.0.0.1:18998'
const requestTimeoutMs = 10000
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(requestTimeoutMs) })
  assert.equal(response.status, 200, `${path} 应返回 200`)
  return response.json()
}

const before = await get('/state/tasks')
assert.ok(Array.isArray(before))
const beforeIds = before.map(task => task.taskId).sort()
const statuses = []
const cases = [
  { name: 'acceptance-criteria-over-32', criteria: Array(33).fill('条件') },
  { name: 'acceptance-criterion-blank', criteria: [' '] },
]
for (const { name, criteria } of cases) {
  const response = await fetch(base + '/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
    signal: AbortSignal.timeout(requestTimeoutMs),
    body: JSON.stringify({
      requestId: `local-deploy-rejected-${name}`,
      groupId: 'local-deploy-invalid',
      title: '零写拒绝验证',
      objective: '不会创建任务',
      context: '入参错误应前置拒绝',
      acceptanceCriteria: criteria,
    }),
  })
  assert.equal(response.status, 400, `${name} 应在入参门禁拒绝`)
  const body = await response.json()
  assert.equal(body.error, 'web_task_request_invalid', name)
  statuses.push(response.status)
}

const after = await get('/state/tasks')
assert.ok(Array.isArray(after))
assert.deepEqual(after.map(task => task.taskId).sort(), beforeIds, '拒绝请求后任务卡片集合必须不变')
const catalog = await get('/state/workflows/catalog')
assert.equal(catalog.workflows.find(workflow => workflow.id === 'task-investigation')?.version, '6')
assert.equal(catalog.workflows.find(workflow => workflow.id === 'task-group-file-delivery')?.version, '2')

const report = {
  checkedAt: new Date().toISOString(),
  base,
  cases: cases.map(({ name }) => name),
  statuses,
  taskCount: after.length,
  taskDelta: after.length - before.length,
  catalog: catalog.workflows.map(workflow => ({ id: workflow.id, version: workflow.version })),
  zeroCreatedTasks: true,
}
// exclusive create 关闭预检与写入之间的覆盖竞态。
await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify(report))
