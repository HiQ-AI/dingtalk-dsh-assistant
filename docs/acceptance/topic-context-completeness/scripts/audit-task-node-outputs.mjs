import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { describeTaskNodeOutput } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'

// 只读当前节点工件；证据不写业务正文，live 模式额外逐页回读部署接口。
const [api, artifacts, outputFile, mode] = process.argv.slice(2)
assert.ok(api && artifacts && outputFile && ['projection', 'live'].includes(mode), 'usage: api artifacts outputFile projection|live')
const read = async path => {
  const response = await fetch(`${api}${path}`)
  assert.equal(response.status, 200)
  return response.json()
}
const tasks = await read('/state/tasks'), rows = []
for (const task of tasks) for (const node of task.executionNodes ?? []) {
  if (!node.outputRef) continue
  assert.match(node.outputRef, /^sha256-[a-f0-9]{64}\.json$/)
  const bytes = await readFile(join(artifacts, node.outputRef))
  assert.equal(`sha256-${createHash('sha256').update(bytes).digest('hex')}.json`, node.outputRef)
  const projected = describeTaskNodeOutput(node, JSON.parse(bytes))
  assert.ok(projected.text.trim() || projected.overview, `${node.nodeId}: missing readable output`)
  let pages = 0
  if (mode === 'live') {
    let cursor = 0, text = ''
    do {
      const page = await read(`/state/tasks/${encodeURIComponent(task.taskId)}/runs/${encodeURIComponent(node.runId)}/nodes/${encodeURIComponent(node.nodeRunId)}/output?ref=${encodeURIComponent(node.outputRef)}&cursor=${cursor}`)
      assert.equal(page.overview, projected.overview)
      text += page.text; pages++
      assert.ok(page.nextCursor === null || page.nextCursor > cursor)
      cursor = page.nextCursor
    } while (cursor !== null)
    assert.equal(text, projected.text)
  }
  rows.push({ nodeId: node.nodeId, outputRef: node.outputRef, textLength: projected.text.length, overview: projected.overview, pages, passed: true })
}
const result = { checkedAt: new Date().toISOString(), mode, tasks: tasks.length, nodes: rows.length, nodeTypes: new Set(rows.map(row => row.nodeId)).size, passed: true, rows }
await mkdir(dirname(outputFile), { recursive: true })
await writeFile(outputFile, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ...result, rows: undefined }))
