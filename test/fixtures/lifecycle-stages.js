import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as timerSetTimeout, clearTimeout as timerClearTimeout } from 'node:timers'
const phases = new AsyncLocalStorage()
export const lifecycleContext = () => phases.getStore()
const setDeadline = timerSetTimeout, clearDeadline = timerClearTimeout

// Real deadlines for preparation, acceptance work, and resource drain. Every
// awaited operation is gated so a timed-out continuation cannot start more work.
export async function lifecycleStages(t, { prepare, business, cleanup, limits = {} }) {
  const context = { directories: [], diagnostic: message => t.diagnostic(message) }
  return phases.run(context, async () => {
  const budgets = { prepare: 30000, business: 30000, cleanup: 20000, ...limits }
  let active, failure
  const pending = new Set()
  const operations = new Set()
  async function phase(name, action) {
    const started = performance.now(), controller = new AbortController()
    active = controller
    context.phase = name; context.signal = controller.signal
    const abort = () => controller.abort(t.signal.reason)
    // Outer cancellation stops acceptance work, but must not skip resource drain.
    if (name !== 'cleanup') t.signal.addEventListener('abort', abort, { once: true })
    let timer
    const expired = () => Object.assign(new Error(`lifecycle ${name} exceeded ${budgets[name]}ms`), { code: 'TEST_STAGE_TIMEOUT', phase: name })
    const deadline = new Promise((_, reject) => {
      const fail = () => { const error = controller.signal.reason; reject(error) }
      controller.signal.addEventListener('abort', fail, { once: true })
      timer = setDeadline(() => controller.abort(expired()), budgets[name])
      if (name !== 'cleanup' && t.signal.aborted) abort()
    })
    const step = async operation => {
      controller.signal.throwIfAborted()
      const work = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation() })
      operations.add(work)
      work.then(() => operations.delete(work), () => operations.delete(work))
      let abort
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
      })
      try {
        const value = await Promise.race([work, cancelled])
        if (performance.now() - started >= budgets[name]) controller.abort(expired())
        controller.signal.throwIfAborted()
        return value
      } finally { controller.signal.removeEventListener('abort', abort) }
    }
    const work = Promise.resolve().then(() => action(step, controller.signal))
    pending.add(work)
    work.then(() => pending.delete(work), () => pending.delete(work))
    try {
      const result = await Promise.race([work, deadline])
      if (performance.now() - started >= budgets[name]) controller.abort(expired())
      controller.signal.throwIfAborted()
      return result
    }
    catch (error) {
      if (error && typeof error === 'object') error.lifecyclePhase ??= name
      throw error
    }
    finally {
      clearDeadline(timer)
      t.signal.removeEventListener('abort', abort)
      t.diagnostic(JSON.stringify({ lifecyclePhase: name, elapsedMs: Math.round(performance.now() - started), aborted: controller.signal.aborted }))
    }
  }
  try {
    const value = await phase('prepare', prepare)
    await phase('business', (step, signal) => business(value, step, signal))
  } catch (error) { active?.abort(error); failure = error }
  const unfinished = [...pending, ...operations]
  try {
    await phase('cleanup', async (step, signal) => {
      await step(() => cleanup(step, signal, () => Promise.allSettled(unfinished)))
      // A failed stage must settle after owned resources have been cancelled.
      await step(() => Promise.allSettled(unfinished))
    })
  } catch (error) { failure = failure ? new AggregateError([failure, error], 'Lifecycle failed and cleanup did not complete') : error }
  if (failure) throw failure
  })
}
