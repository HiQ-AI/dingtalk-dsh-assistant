import { AsyncLocalStorage } from 'node:async_hooks'

// Instrument only the public subprocess capability. Async context attributes a spawn
// to its actual native tool call, including parallel task executions. No OS-wide kill.
const owners = new AsyncLocalStorage()
const installed = new Map()
const failure = cause => Object.assign(new Error('execution_process_drain_failed'), { code: 'execution_process_drain_failed', executionDrained: false, cause })
export function trackDynamicProcesses(service) {
  if (!service) return { run: action => action(), scope: () => ({ run: action => action(), async close() {} }), async close() {} }
  const key = service.identity ?? service
  let state = installed.get(key)
  if (!state) {
    state = { refs: 0, methods: [] }
    for (const method of ['spawn', 'spawnTerminal']) {
      if (typeof service[method] !== 'function') continue
      const original = service[method]
      const wrapped = function (...args) {
        const owner = owners.getStore()
        const handle = original.apply(this, args)
        if (!owner) return handle
        if (handle && typeof handle.then === 'function') {
          const prepared = handle.then(value => { owner.handles.push({ handle: value, terminal: method === 'spawnTerminal' }); return value })
          owner.pending.push(prepared)
          return prepared
        }
        owner.handles.push({ handle, terminal: method === 'spawnTerminal' })
        return handle
      }
      service[method] = wrapped
      state.methods.push({ method, original, wrapped })
    }
    installed.set(key, state)
  }
  state.refs++
  let closed = false
  const scope = () => {
    const owner = { handles: [], pending: [] }
    let closing
    return {
      run(action) {
        if (closed || closing) throw failure(new Error('Process scope closed'))
        return owners.run(owner, action)
      },
      close() {
        return closing ??= (async () => {
          await Promise.allSettled(owner.pending)
          const outcomes = await Promise.allSettled(owner.handles.map(async ({ handle, terminal }) => {
            if (typeof handle?.terminate !== 'function' || !terminal && typeof handle?.waitForExit !== 'function') throw new Error('Subprocess quiescence capability is missing')
            await handle.terminate()
            if (!terminal) await handle.waitForExit()
          }))
          const failed = outcomes.find(outcome => outcome.status === 'rejected')
          if (failed) throw failure(failed.reason)
        })()
      },
    }
  }
  return {
    scope,
    async run(action) {
      const owned = scope()
      try { return await owned.run(action) }
      finally { await owned.close() }
    },
    async close() {
      if (closed) return
      closed = true
      if (--state.refs) return
      for (const { method, original } of state.methods) service[method] = original
      installed.delete(key)
    },
  }
}
