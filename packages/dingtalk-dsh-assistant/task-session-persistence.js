import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { link, lstat, open, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as JsonlSessionPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import { checkedTaskDirectory, taskDirectories, taskFilePath } from './session-workspaces.js'

const JsonlSessionPersistence = JsonlSessionPersistenceModule.default ?? JsonlSessionPersistenceModule
const writerScope = new AsyncLocalStorage()
const installations = new Map()
const installing = new Map()
const methods = ['create', 'open', 'stat', 'list', 'flush']
const failure = code => Object.assign(new Error(code), { code })
const within = (parent, child) => {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
const routeName = id => createHash('sha256').update(id).digest('hex') + '.json'

/** Native event logs live here; this directory is a JSONL backend root, not a copied export. */
export function taskSessionLogRoot(root, taskId) {
  return join(dirname(taskFilePath(root, taskId, 'work')), '.dsh', 'sessions')
}

async function readRoute(path) {
  const entry = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!entry) return null
  if (!entry.isFile() || entry.isSymbolicLink()) throw failure('TASK_SESSION_ROUTE_INVALID')
  return JSON.parse(await readFile(path, 'utf8'))
}

async function checkedNativeLogRoot(directory, create = false) {
  await checkedTaskDirectory(directory, create)
  // Native JSONL owns its layout. Inspect existing entries instead of reproducing its
  // private project/session path encoding; a link at any level must not be followed.
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw failure('TASK_DIRECTORY_OUTSIDE_ROOT')
      if (entry.isDirectory()) {
        const nested = join(path, entry.name)
        await checkedTaskDirectory(nested)
        await inspect(nested)
      }
    }
  }
  await inspect(directory)
  return directory
}

async function syncDirectory(path) {
  // Windows does not expose fsync on directory handles. The native backend owns log durability.
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function publishRoute(path, route) {
  const temp = join(dirname(path), `.pending-${randomUUID()}`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(route) + '\n')
    await handle.sync()
  } finally { await handle.close() }
  try {
    // An atomic, no-clobber publication keeps concurrent registrations from rebinding an id.
    await link(temp, path).catch(error => { if (error.code !== 'EEXIST') throw error })
    await syncDirectory(dirname(path))
  } finally { await rm(temp, { force: true }) }
}

/**
 * Route the mounted persistence service's PUBLIC API while retaining its identity.
 * Alpha2 AgentLoop retains its installation context; replacing a caller's ctx reference or
 * changing meta.cwd alone does not change its backend. Every task backend is the official
 * JSONL plugin on the same Cordis event bus, so native live append/flush/dispose, ownership,
 * replay, compression, format validation and compaction remain native implementations.
 *
 * Registration is durable before agent creation. The index contains only routing metadata;
 * session headers/events are written exactly once, by the task's native JSONL backend.
 * Legacy sessions remain at their original location and are never moved or removed here.
 *
 * The public-call path is revalidated even for cached backends. This is not an OS
 * containment boundary: alpha2's already-open native writers drain on their own timers
 * and event listeners, and an external process can rename a checked directory between
 * validation and native I/O. Tasks must not be granted writes to .dsh/session storage or
 * .session-routes; callers must drain/dispose agents before closing this router.
 */
export async function installTaskSessionPersistence(ctx, options = {}) {
  if (!isAbsolute(options.root ?? '')) throw failure('TASK_SESSION_ROOT_INVALID')
  const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  const key = persistence?.identity ?? persistence
  const existing = installing.get(key)
  if (existing) {
    const installed = await existing
    if (installed.root !== resolve(options.root ?? '')) throw failure('TASK_SESSION_ROOT_CHANGED')
    return installed
  }
  const operation = install(ctx, options)
  installing.set(key, operation)
  try { return await operation } finally { if (installing.get(key) === operation) installing.delete(key) }
}

async function install(ctx, { root, compression } = {}) {
  if (!isAbsolute(root ?? '')) throw failure('TASK_SESSION_ROOT_INVALID')
  root = resolve(root)
  const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  if (!persistence || methods.some(name => typeof persistence[name] !== 'function')
    || typeof ctx.isolate !== 'function' || typeof ctx.plugin !== 'function') throw failure('TASK_SESSION_PERSISTENCE_REQUIRED')
  const key = persistence.identity ?? persistence
  const prior = installations.get(key)
  if (prior) {
    if (prior.root !== root) throw failure('TASK_SESSION_ROOT_CHANGED')
    return prior
  }
  await checkedTaskDirectory(root, true)
  const index = join(root, 'tasks', '.session-routes')
  await checkedTaskDirectory(index, true)
  const originals = Object.fromEntries(methods.map(name => [name, persistence[name]]))
  const legacy = Object.fromEntries(methods.map(name => [name, originals[name].bind(persistence)]))
  const agents = ctx.agents
  const agentMethods = { create: agents.create, resume: agents.resume }
  const backends = new Map(), routes = new Map()
  let closed = false, closing
  const assertOpen = () => { if (closed) throw failure('TASK_SESSION_PERSISTENCE_CLOSED') }
  const validate = value => {
    if (!value || value.version !== 1 || typeof value.sessionId !== 'string' || !value.sessionId
      || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) throw failure('TASK_SESSION_ROUTE_INVALID')
    const taskRoot = dirname(taskFilePath(root, value.taskId, 'work'))
    if (!within(taskRoot, value.cwd) || resolve(value.cwd) !== value.cwd) throw failure('TASK_SESSION_CWD_OUTSIDE_TASK')
    return value
  }
  async function routeFor(id) {
    if (typeof id !== 'string' || !id) throw failure('TASK_SESSION_ID_INVALID')
    await checkedTaskDirectory(index)
    if (routes.has(id)) return routes.get(id)
    const route = await readRoute(join(index, routeName(id)))
    if (!route) return null
    validate(route)
    if (route.sessionId !== id) throw failure('TASK_SESSION_ROUTE_INVALID')
    routes.set(id, Object.freeze(route))
    return route
  }
  async function backendFor(taskId) {
    assertOpen()
    const directory = taskSessionLogRoot(root, taskId)
    // A cached native backend still resolves paths afresh when it writes. Never let
    // a directory replacement after its first use turn that cache into a bypass.
    await checkedNativeLogRoot(directory, !backends.has(taskId))
    if (!backends.has(taskId)) {
      const creating = (async () => {
        const scope = ctx.isolate('sessionPersistence')
        const fiber = scope.plugin(JsonlSessionPersistence, {
          root: directory,
          compression: compression ?? persistence.config?.compression ?? 'zstd',
        })
        await fiber
        // Property access can return an injecting parent's cached service even on
        // an isolated child context. Resolve the actual isolated implementation;
        // returning the public router here recursively calls its own open/create.
        const backend = scope.get('sessionPersistence')
        if (!backend || (backend.identity ?? backend) === key) {
          await fiber.dispose()
          throw failure('TASK_SESSION_PERSISTENCE_BACKEND_INVALID')
        }
        return { persistence: backend, fiber }
      })()
      backends.set(taskId, creating)
      creating.catch(() => { if (backends.get(taskId) === creating) backends.delete(taskId) })
    }
    const backend = (await backends.get(taskId)).persistence
    await checkedNativeLogRoot(directory)
    return backend
  }
  async function routed(id) {
    const route = await routeFor(id)
    return route ? { route, backend: await backendFor(route.taskId) } : null
  }
  async function allRoutes() {
    await checkedTaskDirectory(index)
    const values = []
    for (const entry of await readdir(index, { withFileTypes: true })) {
      if (entry.name.startsWith('.pending-')) continue
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile()) throw failure('TASK_SESSION_ROUTE_INVALID')
      const route = validate(await readRoute(join(index, entry.name)))
      if (entry.name !== routeName(route.sessionId)) throw failure('TASK_SESSION_ROUTE_INVALID')
      routes.set(route.sessionId, Object.freeze(route)); values.push(route)
    }
    return values
  }
  async function legacyConflict(id) {
    if (await legacy.stat(id)) throw failure('TASK_SESSION_LEGACY_LOCATION')
  }
  const assertWriter = route => {
    const token = writerScope.getStore()
    if (!token?.active || token.owner !== key || token.taskId !== route.taskId || token.sessionId !== route.sessionId) throw failure('TASK_SESSION_HOST_WRITER_REQUIRED')
  }
  const api = {
    root,
    async runOwned({ taskId, sessionId }, action) {
      assertOpen()
      const route = await routeFor(sessionId)
      if (!route || route.taskId !== taskId) throw failure('TASK_SESSION_BINDING_REQUIRED')
      const token = { owner: key, taskId, sessionId, active: true }
      try { return await writerScope.run(token, action) } finally { token.active = false }
    },
    async register({ taskId, sessionId, cwd }) {
      assertOpen()
      const route = validate({ version: 1, taskId, sessionId, cwd })
      await taskDirectories(root, taskId)
      await checkedTaskDirectory(cwd, true)
      await legacyConflict(sessionId)
      await backendFor(taskId)
      await checkedTaskDirectory(index)
      await publishRoute(join(index, routeName(sessionId)), route)
      await checkedTaskDirectory(index)
      const saved = await readRoute(join(index, routeName(sessionId)))
      validate(saved)
      if (saved.sessionId !== sessionId || saved.taskId !== taskId || saved.cwd !== cwd) throw failure('TASK_SESSION_BINDING_CONFLICT')
      routes.set(sessionId, Object.freeze(saved))
      await backendFor(taskId)
      return { ...saved, logRoot: taskSessionLogRoot(root, taskId) }
    },
    async close() {
      return closing ??= (async () => {
        closed = true
        const errors = []
        for (const pending of backends.values()) {
          try { await (await pending).fiber.dispose() } catch (error) { errors.push(error) }
        }
        // Cordis wraps method reads, so function-reference equality is not a valid guard here.
        for (const name of methods) persistence[name] = originals[name]
        for (const name of Object.keys(agentMethods)) agents[name] = agentMethods[name]
        installations.delete(key)
        if (errors.length) throw new AggregateError(errors, 'TASK_SESSION_PERSISTENCE_CLOSE_FAILED')
      })()
    },
  }
  const wrappers = {
    async create(header, options) {
      assertOpen(); options?.signal?.throwIfAborted()
      const route = await routeFor(header.id)
      if (!route) {
        if (header.cwd && within(join(root, 'tasks'), resolve(header.cwd))) throw failure('TASK_SESSION_BINDING_REQUIRED')
        return legacy.create(header, options)
      }
      if (header.cwd !== route.cwd) throw failure('TASK_SESSION_CWD_MISMATCH')
      assertWriter(route)
      await legacyConflict(header.id)
      return (await backendFor(route.taskId)).create(header, options)
    },
    async open(id, access, options) {
      assertOpen(); options?.signal?.throwIfAborted()
      const route = await routeFor(id)
      if (!route) return legacy.open(id, access, options)
      if (access !== 'read') assertWriter(route)
      await legacyConflict(id)
      const handle = await (await backendFor(route.taskId)).open(id, access, options)
      if (handle.header.cwd !== route.cwd) {
        await handle.close()
        throw failure('TASK_SESSION_CWD_MISMATCH')
      }
      return handle
    },
    async stat(id, options) {
      assertOpen(); options?.signal?.throwIfAborted()
      const target = await routed(id)
      if (!target) return legacy.stat(id, options)
      await legacyConflict(id)
      const snapshot = await target.backend.stat(id, options)
      if (snapshot && snapshot.header.cwd !== target.route.cwd) throw failure('TASK_SESSION_CWD_MISMATCH')
      return snapshot
    },
    async list(options) {
      assertOpen(); options?.signal?.throwIfAborted()
      const result = [...await legacy.list(options)]
      const ids = new Set(result.map(item => item.header.id))
      const taskIds = new Set((await allRoutes()).map(route => route.taskId))
      for (const taskId of taskIds) for (const item of await (await backendFor(taskId)).list(options)) {
        if (ids.has(item.header.id)) throw failure('TASK_SESSION_DUPLICATE_ID')
        const route = await routeFor(item.header.id)
        if (!route || route.taskId !== taskId || route.cwd !== item.header.cwd) throw failure('TASK_SESSION_ROUTE_INVALID')
        ids.add(item.header.id); result.push(item)
      }
      return result
    },
    async flush() {
      assertOpen()
      await checkedTaskDirectory(index)
      const failures = []
      for (const operation of [() => legacy.flush(), ...[...backends.keys()].map(taskId => async () => (await backendFor(taskId)).flush())]) {
        try { await operation() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'TASK_SESSION_PERSISTENCE_FLUSH_FAILED')
    },
  }
  // 原生委派自行生成子会话 ID；核验存活父对象后，在原生工厂取得日志写者前登记。
  for (const name of Object.keys(agentMethods)) agents[name] = async function (options) {
    const parent = options.parentAgent
    const route = parent && await routeFor(parent.id)
    if (!route) return agentMethods[name].call(this, options)
    assertOpen()
    if (agents.get(parent.id) !== parent) throw failure('TASK_SESSION_BINDING_REQUIRED')
    const sessionId = name === 'create' ? options.sessionId : options.resumeSessionId
    let header = options.meta
    if (name === 'resume') {
      const reader = await persistence.open(sessionId, 'read')
      try { header = reader.header } finally { await reader.close() }
    }
    if (header?.origin !== 'subagent' || header.parentSession !== parent.id || header.cwd !== route.cwd) throw failure('TASK_SESSION_BINDING_REQUIRED')
    options.signal?.throwIfAborted()
    await api.register({ taskId: route.taskId, sessionId, cwd: route.cwd })
    return api.runOwned({ taskId: route.taskId, sessionId }, () => agentMethods[name].call(this, options))
  }
  for (const name of methods) persistence[name] = wrappers[name]
  installations.set(key, api)
  ctx.effect(() => () => api.close(), 'task session native persistence routing')
  return api
}

/** Bind before any stat/inspect/create/resume. Calling without the task router fails closed. */
export async function registerTaskSessionPersistence(ctx, binding) {
  const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  const installation = installations.get(persistence?.identity ?? persistence)
  if (!installation) throw failure('TASK_SESSION_PERSISTENCE_NOT_INSTALLED')
  return installation.register(binding)
}
