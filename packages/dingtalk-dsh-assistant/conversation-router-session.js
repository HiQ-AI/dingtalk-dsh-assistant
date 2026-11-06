import { inboxHasPending } from './session-persistence.js'

const fields = ['groupId', 'conversationType', 'conversationId', 'generation', 'lease', 'sessionId']
const sameBinding = (left, right) => fields.every(key => left?.[key] === right?.[key])
const fail = code => Object.assign(new Error(code), { code })

export function createConversationRouterSessions({ ctx, create, resume, isCurrent }) {
  const live = new Map(), prepared = new Map(), busy = new Set(), starting = new Set()
  const abort = new AbortController()
  let closed = false

  function enter(groupId) {
    if (closed) throw fail('ROUTER_SESSION_CLOSED')
    if (busy.has(groupId)) throw fail('ROUTER_SESSION_BUSY')
    busy.add(groupId)
  }
  async function current(binding) {
    abort.signal.throwIfAborted()
    if (!await isCurrent(binding)) throw fail('ROUTER_SESSION_STALE')
    abort.signal.throwIfAborted()
  }
  async function obtain(binding) {
    await current(binding)
    let entry = live.get(binding.groupId)
    if (entry) {
      if (!sameBinding(entry.binding, binding)) throw fail('ROUTER_SESSION_BINDING_MISMATCH')
      return entry
    }
    const handle = await resume(binding, abort.signal)
    starting.add(handle)
    try {
      abort.signal.throwIfAborted()
      await current(binding)
      entry = { binding: structuredClone(binding), handle }
      live.set(binding.groupId, entry)
      return entry
    } catch (error) {
      await handle.dispose()
      throw error
    } finally { starting.delete(handle) }
  }
  async function flush(handle) {
    if (await ctx.sessions.flush(handle.agent.session) !== true) throw fail('ROUTER_SESSION_NOT_DURABLE')
  }
  function stop(reason) {
    if (closed) return
    closed = true
    abort.abort(reason)
    const handles = new Set([...starting, ...[...live.values(), ...prepared.values()]
      .filter(entry => busy.has(entry.binding.groupId)).map(entry => entry.handle)])
    for (const handle of handles) handle.agent.cancel({ kind: 'user' })
  }
  return {
    async run({ binding, input }) {
      enter(binding.groupId)
      try {
        const entry = await obtain(binding)
        await current(binding)
        entry.handle.agent.steer(input)
        await entry.handle.agent.whenIdle()
        abort.signal.throwIfAborted()
        await flush(entry.handle)
      } finally { busy.delete(binding.groupId) }
    },
    async prepare({ binding }) {
      enter(binding.groupId)
      try {
        if (prepared.has(binding.groupId)) throw fail('ROUTER_SESSION_PREPARED')
        const handle = await create(binding, abort.signal)
        starting.add(handle)
        try {
          abort.signal.throwIfAborted()
          await handle.agent.whenIdle()
          abort.signal.throwIfAborted()
          if (handle.agent.session.id !== binding.sessionId || handle.agent.session.firstLiveSeq !== 0
            || handle.agent.session.inheritedEventCount !== 0 || handle.agent.session.header?.isSeeded === true
            || handle.agent.session.header?.parentSession
            || handle.agent.session.snapshotEvents().some(event => event.type === 'user/message')) throw fail('ROUTER_SESSION_NOT_EMPTY')
          if (inboxHasPending(handle.agent.inbox)) throw fail('ROUTER_SESSION_INBOX_PENDING')
          await flush(handle)
          abort.signal.throwIfAborted()
          prepared.set(binding.groupId, { binding: structuredClone(binding), handle })
        } catch (error) {
          await handle.dispose()
          throw error
        } finally { starting.delete(handle) }
      } finally { busy.delete(binding.groupId) }
    },
    async withIdle({ binding }, callback) {
      enter(binding.groupId)
      try {
        const entry = await obtain(binding)
        await current(binding)
        return await entry.handle.agent.runMaintenance(async signal => {
          if (inboxHasPending(entry.handle.agent.inbox)) throw fail('ROUTER_SESSION_INBOX_PENDING')
          signal.throwIfAborted()
          await current(binding)
          return callback(signal)
        })
      } finally { busy.delete(binding.groupId) }
    },
    async activate({ oldBinding, newBinding }) {
      enter(newBinding.groupId)
      try {
        const candidate = prepared.get(newBinding.groupId)
        if (!candidate || !['groupId', 'conversationType', 'conversationId', 'generation', 'sessionId'].every(key => candidate.binding[key] === newBinding[key])) throw fail('ROUTER_SESSION_PREPARED_MISMATCH')
        const previous = live.get(newBinding.groupId)
        if (previous && !sameBinding(previous.binding, oldBinding)) throw fail('ROUTER_SESSION_BINDING_MISMATCH')
        await current(newBinding)
        candidate.binding = structuredClone(newBinding)
        live.set(newBinding.groupId, candidate)
        prepared.delete(newBinding.groupId)
        if (previous) await previous.handle.dispose()
      } finally { busy.delete(newBinding.groupId) }
    },
    async abortPrepare({ binding }) {
      enter(binding.groupId)
      try {
        const candidate = prepared.get(binding.groupId)
        if (!candidate || candidate.binding.sessionId !== binding.sessionId) throw fail('ROUTER_SESSION_PREPARED_MISMATCH')
        await candidate.handle.dispose()
        prepared.delete(binding.groupId)
      } finally { busy.delete(binding.groupId) }
    },
    async assert(agent, binding) {
      const entry = live.get(binding.groupId)
      if (!entry || entry.handle.agent !== agent || !sameBinding(entry.binding, binding)) throw fail('ROUTER_SESSION_STALE')
      await current(binding)
    },
    stop,
    async close() {
      if (busy.size) throw fail('ROUTER_SESSION_BUSY')
      stop()
      const handles = [...live.values(), ...prepared.values()].map(entry => entry.handle)
      await Promise.all(handles.map(handle => handle.dispose()))
      live.clear(); prepared.clear()
    },
  }
}
