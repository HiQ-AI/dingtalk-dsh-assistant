import { registerHooks } from 'node:module'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd(), output = resolve('docs/acceptance/group-confirmation-review/round-7')
const mode = process.env.GROUP_REVIEW_BASELINE === '1' ? 'baseline' : 'candidate'
mkdirSync(output, { recursive: true })
const traceFile = join(output, `${mode}-${process.pid}.jsonl`)
globalThis.__emptyRecoveryTrace = (kind, value = {}) => appendFileSync(traceFile, JSON.stringify({ kind, observedAt: Date.now(), ...value }) + '\n')
const changed = new Set(['dynamic-task-store.js', 'model-context.js', 'task-boundary-instructions.js',
  'task-session-service.js', 'task-session.js', 'task-source-instructions.js'].map(name => `packages/dingtalk-dsh-assistant/${name}`))
const snapshots = new Map()
if (mode === 'baseline') for (const path of changed) snapshots.set(path, execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context)
  if (!url.startsWith('file:')) return loaded
  const path = relative(root, fileURLToPath(url)).replaceAll('\\', '/')
  if (snapshots.has(path)) return { ...loaded, source: snapshots.get(path) }
  if (path === 'test/fixtures/task-session-native-host.js') {
    const needle = "  h.query = (kind, args = {}) => h.service.store.query({ kind, ...args })"
    const addition = `
  ctx.on('session/event', (session, event) => {
    if (['turn/start', 'turn/end', 'tool/call', 'tool/result'].includes(event.type)) globalThis.__emptyRecoveryTrace('native-event', {
      sessionId: session.id, type: event.type, seq: event.seq, at: event.time,
      ...(event.type === 'tool/call' ? { tool: event.data.name } : {}),
      ...(event.type === 'tool/result' ? { isError: event.data.message?.isError } : {}),
      ...(event.type === 'turn/end' ? { reason: event.data.reason } : {}),
    })
  })
  const traceStates = new Map()
  h.query = async (kind, args = {}) => {
    const result = await h.service.store.query({ kind, ...args })
    if (kind === 'task.get') {
      const state = { status: result.status, lease: result.leaseEpoch, drained: result.drained, nextAttemptAt: result.providerRecovery?.nextAttemptAt, code: result.providerRecovery?.failure?.code }
      const key = JSON.stringify(state)
      if (traceStates.get(result.taskId) !== key) { traceStates.set(result.taskId, key); globalThis.__emptyRecoveryTrace('task-state', state) }
    }
    return result
  }`
    const source = String(loaded.source)
    if (!source.includes(needle)) throw new Error('diagnostic fixture anchor changed')
    return { ...loaded, source: source.replace(needle, addition) }
  }
  if (path === 'test/task-session-service-native.test.js') {
    const source = String(loaded.source), needle = "  try { await waitUntil(async () => (await h.query('task.get', { taskId: created.taskId })).status === 'completed', 'retained execution review', 15000) }"
    if (source.includes(needle)) return { ...loaded, source: source.replace(needle, "  globalThis.__emptyRecoveryTrace('wait-start', { budget: 15000 })\n" + needle) }
    const fixed = "    await waitUntil(() => reviewed, 'retained owner recovery', 10000)"
    if (!source.includes(fixed)) throw new Error('diagnostic test anchor changed')
    return { ...loaded, source: source.replace(fixed, "    globalThis.__emptyRecoveryTrace('wait-start', { budget: 10000, phase: 'recovery' })\n" + fixed) }
  }
  return loaded
} })
