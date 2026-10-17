// Offline only: consume a locally retained raw Host input, never call a model,
// service, connector, or business store. All generated files live in a temp root.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createModelContentIndex, taskModelInput, executionModelInput, modelHostMessage } from '../packages/dingtalk-dsh-assistant/model-context.js'

if (process.argv.length !== 3) throw new Error('Usage: node scripts/replay-host-budget-172.mjs <local-envelope.json>')
const { kind, input, binding = {}, originalHostTextBytes } = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert.ok(['task', 'execution', 'group'].includes(kind), 'kind must be task, execution, or group')
assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'raw Host input required')
const root = await mkdtemp(join(tmpdir(), 'host-budget-172-'))
try {
  const session = { header: { id: 'offline-host-budget', createdAt: '2026-10-17T00:00:00Z', cwd: root }, snapshotEvents: () => [] }
  const index = createModelContentIndex(session, { root: join(root, 'content') })
  const view = kind === 'task' ? taskModelInput(input) : kind === 'execution' ? executionModelInput(input, binding) : input
  const before = index.project(view, { reuseVisible: false }), after = index.host(before, { projected: true })
  const ownPrefix = index.store(null).contentRef.slice(0, 65)
  const reopened = createModelContentIndex(session, { root: join(root, 'content') })
  const serialized = value => JSON.parse(JSON.stringify(value))
  const read = (ref, path = '') => {
    let text = '', offset = 0, page
    do { page = reopened.read({ contentRef: ref, path, offset, limit: 16000 }); text += page.text; offset = page.nextOffset } while (offset !== null)
    return text
  }
  if (after.contextReadRequired) {
    assert.deepEqual(JSON.parse(read(after.contextRef)), serialized(before))
    for (const [key, value] of Object.entries(after)) if (value?.contextPath)
      assert.deepEqual(JSON.parse(read(after.contextRef, value.contextPath)), serialized(before[key]))
  } else assert.deepEqual(after, before)
  const seen = new Set()
  const verifyRefs = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (['contentRef', 'contextRef'].includes(key) && typeof child === 'string' && child.startsWith(ownPrefix) && !seen.has(child)) {
        seen.add(child)
        const text = read(child)
        let decoded
        try { decoded = JSON.parse(text) } catch { continue }
        verifyRefs(decoded)
      } else verifyRefs(child)
    }
  }
  verifyRefs(after)
  const message = modelHostMessage(createUserMessage({ source: { kind: 'coordinator' }, content: [{ type: 'text', text: JSON.stringify(input) }] }), after)
  const finalHostTextBytes = message.content.filter(block => block.type === 'text').reduce((sum, block) => sum + Buffer.byteLength(block.text), 0)
  assert.ok(finalHostTextBytes <= 3000)
  console.log(JSON.stringify({ kind, ...(Number.isSafeInteger(originalHostTextBytes) ? { originalHostTextBytes } : {}),
    isolatedProjectionBeforeBytes: Buffer.byteLength(JSON.stringify(before)), finalHostTextBytes, verifiedGeneratedReferences: seen.size,
    snapshotAndPointersExact: true, businessCalls: 0, originalFilesModified: false }))
} finally { await rm(root, { recursive: true, force: true }) }
