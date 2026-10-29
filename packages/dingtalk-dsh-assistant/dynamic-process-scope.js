import { AsyncLocalStorage } from 'node:async_hooks'

// Instrument only the public subprocess capability. Async context attributes a spawn
// to its actual native tool call, including parallel task executions. No OS-wide kill.
const owners = new AsyncLocalStorage()
const installed = new Map()
const failure = (cause, phase) => Object.assign(new Error(`execution_process_drain_failed: ${phase ?? 'scope'}: ${String(cause?.message ?? cause).slice(0, 2000)}`), { code: 'execution_process_drain_failed', executionDrained: false, cause, phase })
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
    let closing, sealed = false
    return {
      run(action) {
        if (closed || sealed) throw failure(new Error('Process scope closed'))
        return owners.run(owner, action)
      },
      close() {
        sealed = true
        return closing ??= (async () => {
          const pending = await Promise.allSettled(owner.pending)
          const outcomes = await Promise.allSettled(owner.handles.map(async owned => {
            if (owned.drained) return
            const { handle, terminal } = owned
            if (typeof handle?.terminate !== 'function' || !terminal && typeof handle?.waitForExit !== 'function') throw failure(new Error('Subprocess quiescence capability is missing'), 'capability')
            try { await handle.terminate() } catch (cause) { throw failure(cause, 'terminate') }
            if (!terminal) {
              try {
                if (await handle.waitForExit() !== true) throw new Error('Managed process range exit is unproven')
              } catch (cause) { throw failure(cause, 'waitForExit') }
            }
            owned.drained = true
          }))
          const failed = outcomes.find(outcome => outcome.status === 'rejected')
          if (failed) throw failed.reason
          const allocation = pending.find(outcome => outcome.status === 'rejected')
          if (allocation) throw failure(allocation.reason, 'allocation')
        })().catch(error => {
          // Keep the original handles, but not a rejected Promise. A later explicit
          // drain may verify them again; this sealed scope can never launch work.
          closing = undefined
          throw error
        })
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
