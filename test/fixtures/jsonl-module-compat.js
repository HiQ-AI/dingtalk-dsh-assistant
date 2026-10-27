// A separate process prevents the workspace's alpha.2 module cache from masking
// an rc.2 import failure. Every native module is resolved from the chosen profile.
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const [profile, expectedVersion] = process.argv.slice(2)
const requireProfile = createRequire(resolve(profile))
const resolutions = new Map()
registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@deepseek-ai/dsh-') && specifier !== '@deepseek-ai/cordis') return nextResolve(specifier, context)
  const result = nextResolve(specifier, expectedVersion === '0.2.1-rc.2' ? { ...context, parentURL: pathToFileURL(resolve(profile)).href } : context)
  resolutions.set(specifier, fileURLToPath(result.url))
  return result
} })
const jsonlPath = requireProfile.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json')
const manifest = JSON.parse(readFileSync(jsonlPath, 'utf8'))
assert.equal(manifest.version, expectedVersion, 'must test the requested real package version')
const JsonlModule = await import('@deepseek-ai/dsh-session-persistence-jsonl')
assert.equal(typeof (JsonlModule.default ?? JsonlModule.apply), 'function')
if (expectedVersion === '0.2.1-rc.2') assert.equal(JsonlModule.default, undefined)
const { Context } = await import('@deepseek-ai/cordis')
const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const { SessionStore, appendPluginRecord } = await import('@deepseek-ai/dsh-session')
const { installTaskSessionPersistence, taskSessionLogRoot } = await import('../../packages/dingtalk-dsh-assistant/task-session-persistence.js')
const { taskWorkspace } = await import('../../packages/dingtalk-dsh-assistant/session-workspaces.js')
const { inspectSession } = await import('../../packages/dingtalk-dsh-assistant/session-persistence.js')
// This is the actual Resident dependency graph, not an isolated fake export.
await import('../../packages/dingtalk-dsh-assistant/resident.js')
const root = await mkdtemp(join(tmpdir(), 'jsonl-real-package-')), ctx = new Context()
let router
try {
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  await ctx.plugin(JsonlModule.default ?? JsonlModule, { root: join(root, 'legacy'), compression: 'none' })
  router = await installTaskSessionPersistence(ctx, { root, compression: 'none' })
  const cwd = await taskWorkspace(root, 'compat-task'), sessionId = 'compat-owner'
  await router.register({ taskId: 'compat-task', sessionId, cwd })
  const session = ctx.sessions.prepare(sessionId, { meta: { cwd } })
  appendPluginRecord(session, 'plugin:compat/proof', { value: 'persisted-by-real-jsonl' })
  const writer = await router.runOwned({ taskId: 'compat-task', sessionId }, () => ctx.sessionPersistence.create(session.header))
  await writer.append(session.snapshotEvents())
  await writer.flush(); await writer.close()
  await assert.rejects(ctx.sessionPersistence.open(sessionId, 'write'), { code: 'TASK_SESSION_HOST_WRITER_REQUIRED' })
  const before = await inspectSession(ctx.sessionPersistence, sessionId)
  assert.equal(before.meta.cwd, cwd)
  assert.ok(before.events.some(event => event.data?.value === 'persisted-by-real-jsonl'))
  assert.equal((await ctx.sessionPersistence.list()).length, 1)
  await router.close()
  router = await installTaskSessionPersistence(ctx, { root, compression: 'none' })
  assert.deepEqual((await inspectSession(ctx.sessionPersistence, sessionId)).events, before.events)
  const files = []
  async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) await walk(child); else files.push(child) } }
  await walk(taskSessionLogRoot(root, 'compat-task'))
  assert.ok(files.some(path => path.endsWith('.jsonl')))
  if (expectedVersion === '0.2.1-rc.2') for (const path of resolutions.values()) assert.ok(!relative(dirname(resolve(profile)), path).startsWith('..'), `native dependency escaped rc.2 profile: ${path}`)
  console.log(JSON.stringify({ version: manifest.version, jsonlPath, exports: Object.keys(JsonlModule), nativeModuleCount: resolutions.size,
    verified: ['real Resident module import', 'native plugin activation', 'task-owned JSONL write/flush/read', 'Host writer rejection', 'durable route reopen'] }))
} finally { await router?.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
