import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Session } from '@deepseek-ai/dsh-session'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => i % 2 ? pairs : [...pairs, [value, all[i + 1]]], []))
if (!args['--session'] || !args['--output'] || !Number.isSafeInteger(Number(args['--lease']))) throw new Error('require --session, --lease, --output')
const implementation = args['--module'] ? pathToFileURL(resolve(args['--module'])) : new URL('../../../../packages/dingtalk-dsh-assistant/model-context.js', import.meta.url)
const { createModelContentIndex, taskModelInput } = await import(implementation.href)
const originalLog = await readFile(args['--session'])
const records = originalLog.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
const shown = records.findLast(event => event.type === 'user/message' && event.data.source?.taskSession?.leaseEpoch === Number(args['--lease']) && event.data.source.rawHostMessageId && !event.data.source.taskContextHistory)
assert.ok(shown, 'exact projected native Host input exists')
const message = records.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : []).find(item => item.id === shown.data.source.rawHostMessageId)
assert.ok(message, 'original admitted message is still present')
const input = JSON.parse(message.content[0].text), old = JSON.parse(shown.data.content[0].text)
const temporaryBase = resolve('docs/tmp/task-context-measurement')
await mkdir(temporaryBase, { recursive: true })
const root = await mkdtemp(resolve(temporaryBase, 'run-'))
try {
  const index = createModelContentIndex(Session.create('task-context-measurement'), { root })
  const projected = index.project(taskModelInput(input), { reuseVisible: false })
  const read = (value, path = '') => {
    if (!value?.contentRef) return value
    let offset = 0, text = '', page
    do { page = index.read({ contentRef: value.contentRef, path, offset, limit: 16000 }); text += page.text; offset = page.nextOffset } while (offset !== null)
    return page.format === 'json' ? JSON.parse(text) : text
  }
  for (const item of projected.sources) {
    const original = input.sources.find(source => source.sourceId === item.sourceId)
    assert.equal(item.actorId, original.actorId)
    assert.equal(read(item.text), original.text)
    assert.equal(read(item.body), original.body)
    assert.deepEqual(read(projected.sourceCatalog.catalogRef, '/' + item.sourceId), original)
  }
  assert.deepEqual(read(projected.task.fullRecord), input.task)
  assert.deepEqual(read(projected.materialCatalogRef), input.materials)
  for (const item of input.executions) assert.deepEqual(read(projected.executionIndex.catalogRef, '/' + item.executionId), item)
  const bytes = value => Buffer.byteLength(JSON.stringify(value))
  const sizes = value => Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bytes(child)]).sort((a, b) => b[1] - a[1]))
  const native = Session.create(records[0].id, records.slice(1), records[0])
  const events = native.snapshotEvents()
  const hostMessages = native.surface.nodes.map(seq => native.deriveEventMessage(events[seq]))
    .filter(message => message?.source?.taskSession?.taskId === input.task.taskId)
  assert.ok((await readFile(args['--session'])).subarray(0, originalLog.length).equals(originalLog), 'original audit prefix unchanged')
  const result = { scope: 'exact native Host JSON UTF-8 bytes; not tokens, billing or complete model request',
    leaseEpoch: Number(args['--lease']), originalAuditBytes: bytes(input), beforeBytes: bytes(old), afterBytes: bytes(projected),
    reductionPercent: Number(((1 - bytes(projected) / bytes(old)) * 100).toFixed(1)), before: sizes(old), after: sizes(projected),
    nativeVisibleHost: { count: hostMessages.length, historicalMarkers: hostMessages.filter(message => message.source.taskContextHistory).length,
      textBytes: hostMessages.reduce((total, message) => total + message.content.filter(block => block.type === 'text').reduce((sum, block) => sum + Buffer.byteLength(block.text), 0), 0),
      leaseEpochs: hostMessages.map(message => message.source.taskSession.leaseEpoch) },
    checks: { originalAuditUnchanged: true, sourceIdentitiesAndBodiesExact: projected.sources.length, completeCatalogSources: input.sources.length,
      taskAndMaterialsExact: true, executionCatalogExact: input.executions.length, activeOperations: projected.operations.length } }
  await writeFile(args['--output'], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ beforeBytes: result.beforeBytes, afterBytes: result.afterBytes, reductionPercent: result.reductionPercent, nativeVisibleHost: result.nativeVisibleHost, checks: result.checks }))
} finally {
  assert.equal(dirname(root), temporaryBase)
  await rm(root, { recursive: true, force: true })
}
