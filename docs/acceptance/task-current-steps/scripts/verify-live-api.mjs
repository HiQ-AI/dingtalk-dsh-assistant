import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const base = 'http://127.0.0.1:18998'
const replay = JSON.parse(await fs.readFile('docs/tmp/task-current-steps/completed-copy-3/replay-details.json', 'utf8'))
async function get(path) {
  const response = await fetch(base + path)
  assert.equal(response.status, 200)
  return response.json()
}
const cases = []
for (const item of replay) {
  const detail = await get(`/state/tasks/${item.taskId}/detail`)
  assert.equal(detail.state, 'completed')
  assert.deepEqual(detail.executionNodes.map(node => node.nodeRunId), item.detail.executionNodes.map(node => node.nodeRunId))
  assert.equal(new Set(detail.executionNodes.map(node => node.stepKey)).size, detail.executionNodes.length)
  let pages = 0, characters = 0
  for (const node of detail.executionNodes) {
    if (!node.outputRef) continue
    let cursor = 0, text = ''
    for (;;) {
      const query = new URLSearchParams({ ref: node.outputRef, detailRevision: detail.detailRevision, cursor: String(cursor), limit: '1200' })
      const output = await get(`/state/tasks/${detail.taskId}/runs/${node.runId}/nodes/${node.nodeRunId}/output?${query}`)
      pages++; text += output.text
      if (output.nextCursor === null) { assert.equal(text.length, output.totalLength); break }
      assert.ok(output.nextCursor > cursor)
      cursor = output.nextCursor
    }
    assert.equal(text, item.outputs.find(output => output.nodeRunId === node.nodeRunId).text)
    characters += text.length
  }
  const node = detail.executionNodes.find(node => node.outputRef)
  const query = new URLSearchParams({ ref: node.outputRef, detailRevision: 'stale' })
  const stale = await fetch(`${base}/state/tasks/${detail.taskId}/runs/${node.runId}/nodes/${node.nodeRunId}/output?${query}`)
  assert.equal(stale.status, 409)
  cases.push({ stages: detail.plan.stages.length, nodes: detail.executionNodes.length, pages, characters, staleStatus: stale.status })
}
const health = await get('/health')
assert.equal(health.status, 'ok'); assert.equal(health.recoveryIssueCount, 0)
const result = { passed: true, cases, health: { status: health.status, recoveryIssueCount: health.recoveryIssueCount }, writes: 0, boundary: '正式安装实例GET接口只读，未重跑任务或发送消息' }
await fs.writeFile('docs/acceptance/task-current-steps/live-api-summary.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
