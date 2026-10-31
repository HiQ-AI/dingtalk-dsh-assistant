import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lifecycleStages, lifecycleContext } from './lifecycle-stages.js'

const scope = new AsyncLocalStorage()
const activeState = () => scope.getStore() ?? lifecycleContext()
const preparationMs = 30000, cleanupMs = 20000
const businessBudget = value => value === undefined ? 30000 : value
export const nativeLifecycleTimeout = value => businessBudget(value) + preparationMs + cleanupMs

// Called by the shared real Host as soon as its idempotent close exists. This
// also lets cancellation drain a constructor before the caller receives it.
export function registerNativeCleanup(close) { scope.getStore()?.resources.add(close) }
export const nativeLifecycleSignal = () => scope.getStore()?.signal
export function nativeTemporaryDirectory(...args) {
  const state = activeState()
  const pending = mkdtemp(...args)
  if (!state) return pending
  return pending.then(root => {
    const absolutePrefix = resolve(args[0]), absoluteRoot = resolve(root)
    if (dirname(absoluteRoot) !== dirname(absolutePrefix) || !absoluteRoot.startsWith(absolutePrefix)
      || absoluteRoot === absolutePrefix) throw new Error('Native temporary directory escaped its creation prefix')
    state.directories.push(absoluteRoot)
    return root
  })
}

function createCleanupTrace(state, cleanupSignal, diagnostic) {
  if (state.cleanup) return state.cleanup
  const trace = state.cleanup = { signal: cleanupSignal, pending: new Set(), failed: false, verbose: !!process.env.DSH_NATIVE_CLEANUP_DIAGNOSTICS }
  trace.emit = (event, entry, outcome) => {
    const message = JSON.stringify({
      cleanupEvent: event, ...(entry ? { stage: entry.stage, elapsedMs: Math.round(performance.now() - entry.started), outcome } : {}),
      pending: [...trace.pending].map(item => ({ stage: item.stage, elapsedMs: Math.round(performance.now() - item.started) })),
      ownedRootCount: state.directories.length, aborted: cleanupSignal.aborted,
    })
    // Node may silently discard t.diagnostic after its test context has ended.
    if (cleanupSignal.aborted) {
      process.stderr.write(message + '\n')
      try { diagnostic(message) } catch {} // A completed Node context cannot own late records.
    } else diagnostic(message)
  }
  cleanupSignal.addEventListener('abort', () => trace.emit('deadline-unsettled'), { once: true })
  return trace
}
function cleanupTrace() {
  const state = activeState(), phase = lifecycleContext()
  if (state?.cleanup) return state.cleanup
  if (state && phase?.phase === 'cleanup') return createCleanupTrace(state, phase.signal, phase.diagnostic)
}
export const nativeCleanupSignal = () => cleanupTrace()?.signal

// Observe the real operation; a deadline does not claim to cancel its Promise.
export function nativeCleanupStage(name, action) {
  const trace = cleanupTrace()
  if (!trace) return action()
  const entry = { stage: name, started: performance.now() }
  trace.pending.add(entry)
  if (trace.verbose) trace.emit('operation-start', entry)
  const finish = outcome => {
    trace.pending.delete(entry)
    if (outcome === 'failed') trace.failed = true
    if (trace.verbose || trace.signal.aborted) trace.emit(trace.signal.aborted ? 'late-settlement' : 'operation-settled', entry, outcome)
  }
  let result
  try { result = action() } catch (error) { finish('failed'); throw error }
  return Promise.resolve(result).then(value => { finish('settled'); return value }, error => { finish('failed'); throw error })
}

// Instrument only this disposable test Host's own public methods. Restore an
// own descriptor only if nobody else replaced it while closing.
export function instrumentNativeCleanupMethod(target, key, label) {
  if (!activeState() || !target || typeof target[key] !== 'function') return () => {}
  const descriptor = Object.getOwnPropertyDescriptor(target, key), original = target[key]
  const wrapped = function (...args) { return nativeCleanupStage(label, () => Reflect.apply(original, this, args)) }
  try { Object.defineProperty(target, key, { value: wrapped, configurable: true, writable: true }) }
  catch {
    const trace = cleanupTrace()
    if (trace?.verbose) trace.emit('instrumentation-unavailable', { stage: label, started: performance.now() }, 'parent-span-only')
    return () => {}
  } // Frozen/private methods remain inside their parent close span.
  return () => {
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapped) return
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else delete target[key]
  }
}

// Imported as fs.rm only by the audited native test files. Outside a lifecycle,
// and for business operations, preserve the original call and Promise exactly.
export function nativeRemove(...args) {
  const state = activeState(), trace = cleanupTrace()
  if (!trace) return rm(...args)
  const input = args[0]
  const path = typeof input === 'string' ? resolve(input) : input instanceof URL ? resolve(fileURLToPath(input)) : Buffer.isBuffer(input) ? resolve(input.toString()) : null
  const owned = path && state.directories.some(root => { const suffix = relative(root, path); return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep) })
  if (!owned) return rm(...args)
  if (trace.signal.aborted || trace.failed) {
    trace.emit('removal-blocked')
    return Promise.reject(trace.signal.reason ?? new Error('Native cleanup failed; owned directory retained'))
  }
  return nativeCleanupStage('directory.remove', () => rm(...args))
}

// Keep the original callback/lexical state and Node registration API. The one
// explicit handoff is recorded in native-lifecycle-coverage.json for each case.
export function nativeLifecycle(value, run, bounds = {}) {
  const registeredParentSignal = scope.getStore()?.signal
  const budget = businessBudget(value)
  if (!Number.isFinite(budget) || budget <= 0) throw new TypeError('Invalid native business deadline')
  const prepare = bounds.prepare ?? preparationMs, cleanup = bounds.cleanup ?? cleanupMs
  if (!(prepare > 0 && prepare <= preparationMs && cleanup > 0 && cleanup <= cleanupMs)) throw new TypeError('Native test-only bounds may only tighten the production limits')
  return async (t, ...args) => {
    const parentSignal = scope.getStore()?.signal ?? registeredParentSignal
    const outerSignal = parentSignal ? AbortSignal.any([t.signal, parentSignal]) : t.signal
    const state = { resources: new Set(), directories: [], hooks: [], finalizers: [], cancellations: [], failure: null, skipped: false }
    const prepared = Promise.withResolvers(), released = Promise.withResolvers()
    released.promise.catch(() => {})
    let body, step, signal, enteredBusiness = false
    const context = new Proxy(t, {
      get(target, key) {
        if (key === 'signal') return signal
        if (key === 'after') return (hook, options) => {
          if (options?.timeout !== undefined) throw new Error('Explicit cleanup deadline needs a reviewed contract')
          state.hooks.push(hook)
        }
        if (key === 'skip') return (...args) => { state.skipped = true; return target.skip(...args) }
        if (key === 'step') return action => step(action)
        if (key === 'onCancel') return action => state.cancellations.push(action)
        if (key === 'finallyCleanup') return action => state.finalizers.push(action)
        if (key === 'beginBusiness') return async () => {
          if (enteredBusiness) throw new Error('Native business phase may start only once')
          if (state.failure) throw state.failure
          enteredBusiness = true
          prepared.resolve()
          await released.promise
          if (state.failure) throw state.failure
          signal.throwIfAborted()
        }
        const member = Reflect.get(target, key, target)
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    const bindPhase = (gate, phaseSignal) => {
      step = gate; signal = phaseSignal
      state.signal = phaseSignal
      phaseSignal.addEventListener('abort', () => { state.failure ??= phaseSignal.reason }, { once: true })
      if (phaseSignal.aborted) state.failure ??= phaseSignal.reason
    }
    await scope.run(state, () => lifecycleStages({ signal: outerSignal, diagnostic: message => t.diagnostic(message) }, {
      limits: { prepare, business: budget, cleanup },
      prepare: async (gate, phaseSignal) => {
        bindPhase(gate, phaseSignal)
        phaseSignal.throwIfAborted()
        body = Promise.resolve().then(() => { phaseSignal.throwIfAborted(); return run(context, ...args) })
        body.catch(error => { state.failure ??= error })
        await Promise.race([prepared.promise, body.then(() => {
          if (!enteredBusiness && !state.skipped) throw new Error('Native lifecycle callback did not reach its explicit business boundary')
        })])
      },
      business: async (_value, gate, phaseSignal) => {
        bindPhase(gate, phaseSignal)
        phaseSignal.throwIfAborted()
        released.resolve()
        await body
      },
      cleanup: async (gate, cleanupSignal, drain) => {
        createCleanupTrace(state, cleanupSignal, message => t.diagnostic(message))
        const errors = []
        const closeResources = async () => {
          for (const close of [...state.resources].toReversed()) {
            try { await gate(() => nativeCleanupStage('resource.close', close)) } catch (error) { errors.push(error) }
          }
        }
        if (state.failure) {
          released.reject(state.failure)
          for (const release of state.cancellations) {
            try { await gate(release) } catch (error) { errors.push(error) }
          }
          await closeResources()
          await gate(() => body?.catch(() => {}))
          await gate(drain)
          if (errors.length) throw new AggregateError(errors, 'Native cancellation did not drain owned resources')
        }
        // Node t.after hooks run FIFO. Keep that order and their real assertions.
        // Normal cleanup uses the original hooks before the idempotent fallback.
        for (const hook of [...state.finalizers].toReversed().concat(state.hooks)) {
          try { await gate(() => nativeCleanupStage('after.hook', () => hook(context))) } catch (error) { errors.push(error) }
        }
        await closeResources()
        if (errors.length) throw new AggregateError(errors, 'Native cleanup failed; temporary roots retained')
        for (const root of state.directories.toReversed()) await gate(() => nativeRemove(root, { recursive: true, force: true }))
      },
    }))
  }
}
