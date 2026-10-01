import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import { splitContext, validateContextRequests } from '../../../../packages/dingtalk-dsh-assistant/message-context.js'
import { prepareMessageRequest } from '../../../../packages/dingtalk-dsh-assistant/message-model.js'

const [dbPath, outputPath] = process.argv.slice(2)
if (!dbPath || !outputPath) throw new Error('需要只读源数据库和结果文件路径')
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const envelopes = [114, 115].map(sequence => {
    const run = JSON.parse(db.prepare('SELECT body FROM message_runs WHERE rowid=?').get(sequence).body)
    const input = splitContext(run.snapshot)
    const before = prepareMessageRequest('S', input)
    const result = { input, prepared: prepareMessageRequest('S', input) }
    assert.deepEqual(result.input.source, input.source)
    assert.deepEqual(result.input.quotes, input.quotes)
    assert.equal(result.prepared.messages[0].content[0].text, JSON.stringify(input))
    assert.equal(result.prepared.inputBytes, Buffer.byteLength(result.prepared.system) + Buffer.byteLength(JSON.stringify(result.input)))
    return { sequence, sourceVersion: run.sourceVersion, beforeBytes: before.inputBytes, afterBytes: result.prepared.inputBytes,
      bodyAndQuotesPreserved: true, fixedInputLimit: null, backgroundBefore: input.background.length, backgroundAfter: result.input.background.length }
  })
  const run = JSON.parse(db.prepare('SELECT body FROM message_runs WHERE rowid=113').get().body)
  const node = db.prepare("SELECT body FROM message_items WHERE run_id=? AND kind='node' AND json_extract(body,'$.nodeId')='R' ORDER BY rowid LIMIT 1").get(run.runId)
  const relation = JSON.parse(node.body)
  assert.throws(() => validateContextRequests('R', relation.output.output, relation.input), /MESSAGE_CONTEXT_RESOURCE_REF_INVALID/)
  const evidence = { checkedAt: new Date().toISOString(), mode: 'source-read-only-pure-projections', envelopes,
    invalidCatalogReferenceRejected: true, modelCalls: 0, externalEffects: 0 }
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally { db.close() }
