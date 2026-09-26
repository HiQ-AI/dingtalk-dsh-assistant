import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { describeTaskNodeOutput } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'

// 只读当前节点工件；证据不写业务正文，live 模式额外逐页回读部署接口。
const [api, artifacts, outputFile, mode, controlDbPath] = process.argv.slice(2)
assert.ok(api && artifacts && outputFile && controlDbPath && ['projection', 'live'].includes(mode), 'usage: api artifacts outputFile projection|live controlDbPath')
const db = new DatabaseSync(controlDbPath, { readOnly: true })
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
  const artifact = JSON.parse(bytes), context = {}
  if (node.nodeId === 'prepare-workspace' && !artifact.workspace) {
    const effects = db.prepare('SELECT definition_json,result_json FROM execution_effects WHERE node_run_id=? AND generation=? AND state=?').all(node.nodeRunId, node.generation, 'succeeded')
    for (const row of effects) {
      const definition = JSON.parse(row.definition_json), result = JSON.parse(row.result_json)
      if (definition.action === 'workspace' && result?.result?.status === 'succeeded') context.workspace = { ...result.result, sourceRepository: definition.payload.sourceRepository }
    }
  }
  if (node.nodeId === 'prepare-generation' && !artifact.startingPoint) {
    const record = db.prepare('SELECT w.body FROM message_workflows w JOIN execution_runs r ON w.digest=r.workflow_digest WHERE r.run_id=?').get(node.runId)
    if (record) { const saved = JSON.parse(record.body).config; context.startingPoint = { repository: saved.repoId, workBranch: saved.head } }
  }
  const projected = describeTaskNodeOutput(node, artifact, context)
  assert.ok(projected.text.trim() || projected.overview, `${node.nodeId}: missing readable output`)
  let pages = 0
  if (mode === 'live') {
    let cursor = 0, text = ''
    do {
      const page = await read(`/state/tasks/${encodeURIComponent(task.taskId)}/runs/${encodeURIComponent(node.runId)}/nodes/${encodeURIComponent(node.nodeRunId)}/output?ref=${encodeURIComponent(node.outputRef)}&cursor=${cursor}`)
      assert.equal(page.overview, ['inspect-and-propose', 'propose-changes', 'validate-proposal'].includes(node.nodeId) ? '' : projected.overview)
      text += page.text; pages++
      assert.ok(page.nextCursor === null || page.nextCursor > cursor)
      cursor = page.nextCursor
    } while (cursor !== null)
    const pathOnly = ['inspect-and-propose', 'propose-changes', 'validate-proposal'].includes(node.nodeId)
    assert.equal(pathOnly ? text.replaceAll('\\', '/') : text, pathOnly ? `方案工件路径\n${join(artifacts, node.outputRef)}`.replaceAll('\\', '/') : projected.text)
    if (projected.document) {
      const response = await fetch(`${api}/state/tasks/${encodeURIComponent(task.taskId)}/runs/${encodeURIComponent(node.runId)}/nodes/${encodeURIComponent(node.nodeRunId)}/document?ref=${encodeURIComponent(node.outputRef)}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/markdown/)
      assert.equal(await response.text(), projected.document.content)
    }
  }
  rows.push({ nodeId: node.nodeId, outputRef: node.outputRef, textLength: projected.text.length, overview: projected.overview, documentName: projected.document?.name, pages, passed: true })
}
db.close()
const result = { checkedAt: new Date().toISOString(), mode, tasks: tasks.length, nodes: rows.length, nodeTypes: new Set(rows.map(row => row.nodeId)).size, passed: true, rows }
await mkdir(dirname(outputFile), { recursive: true })
await writeFile(outputFile, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ...result, rows: undefined }))
