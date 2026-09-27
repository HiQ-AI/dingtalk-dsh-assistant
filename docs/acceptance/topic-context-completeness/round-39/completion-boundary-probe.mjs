import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

// 使用当前源码中的实际完成准入回调；依赖为隔离夹具，不连接运行实例。
const source = await readFile(new URL('../../../../packages/dingtalk-dsh-assistant/workflow-service.js', import.meta.url), 'utf8')
const start = source.indexOf('authorizeCompletion: async ({ taskId, decision }) => {')
const end = source.indexOf('\n    authorizeStages:', start)
assert.ok(start > 0 && end > start)
const callback = source.slice(start + 'authorizeCompletion: '.length, end).trim().replace(/,$/, '')
const artifactRef = 'sha256-synthetic-result.json'
const plan = { task: { status: 'succeeded', planRequirementRevision: 1, requirementRevision: 1, requirementRef: 'request' },
  stages: [{ workflowId: 'task-investigation', status: 'succeeded', outputRef: artifactRef, evidenceRefs: [artifactRef] }] }
const requirement = { request: '调查当前材料能否确认测试账号创建人；无法确认时说明原因并结束调查', acceptanceCriteria: ['给出当前材料支持的调查结论'] }
const decision = { summary: '调查已完成，材料不足以确认创建人。', evidenceRefs: [artifactRef],
  assessments: [{ itemId: 'criterion-1', status: 'satisfied', evidenceRefs: [artifactRef] }] }
let output
const controller = { taskPlan: async () => plan }
const artifacts = { read: async ref => ref === 'request' ? requirement : output }
const store = { query: async q => q.kind === 'task.origin' ? { channel: 'im' } : [{ itemId: 'criterion-1' }] }
const check = new Function('controller', 'artifacts', 'store', `return (${callback})`)(controller, artifacts, store)
const results = []
for (const limitations of [[], ['当前材料未提供创建人，不能确认账号由谁创建。']]) {
  output = { summary: decision.summary, evidenceIds: ['source-1'], findings: [{ statement: '材料没有创建人字段', evidenceIds: ['source-1'] }], limitations }
  results.push({ limitations, authorized: await check({ taskId: 'synthetic-task', decision }) })
}
assert.equal(results[0].authorized, true)
assert.equal(results[1].authorized, false)
const result = { scope: '当前完成回调的隔离决策检查；不是实际账号或真实 Task 重放', results }
await writeFile(new URL('./completion-boundary-probe.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
