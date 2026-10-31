/** Aggregate phase timings only: never include paths, task ids or business data. */
export function createStartupMetrics(observe) {
  const started = performance.now()
  const phases = []
  const record = (phase, since, status = 'ok', counts = {}) => {
    const sample = { phase, durationMs: Math.max(0, performance.now() - since), elapsedMs: Math.max(0, performance.now() - started), status,
      ...Object.fromEntries(Object.entries(counts).filter(([, value]) => Number.isSafeInteger(value) && value >= 0)) }
    phases.push(sample)
    try { observe?.({ ...sample }) } catch { /* Observability must not change recovery. */ }
    return sample
  }
  return { record, snapshot: () => phases.map(sample => ({ ...sample })),
    async measure(phase, action) {
      const since = performance.now()
      try { const value = await action(); record(phase, since); return value }
      catch (error) { record(phase, since, 'failed'); throw error }
    } }
}

// Optional, explicitly injected diagnostics. Without an observer the original
// action and its Promise are returned directly; no clocks or logs are added.
export const observeClose = (trace, stage, action, counts) => trace ? trace.step(stage, action, counts) : action()

export function createCloseObservation(observer) {
  if (observer === undefined) return undefined
  if (typeof observer !== 'function') throw new TypeError('closeObserver must be a function')
  const pending = new Set()
  const snapshot = () => ({ pending: [...pending].map(entry => ({
    stage: entry.stage, elapsedMs: Math.round(performance.now() - entry.started), ...(entry.counts ? { counts: entry.counts() } : {}),
  })) })
  const notify = (event, entry, error) => {
    try { observer({ closeEvent: event, stage: entry.stage,
      elapsedMs: Math.round(performance.now() - entry.started), ...(entry.counts ? { counts: entry.counts() } : {}), ...(error ? { errorCode: error.code ?? error.name } : {}),
      ...snapshot(), readPending: snapshot }) }
    catch (diagnosticError) {
      // A broken observer must not skip a real close or replace its exception.
      process.stderr.write(JSON.stringify({ closeEvent: 'observer-error', errorCode: diagnosticError.code ?? diagnosticError.name }) + '\n')
    }
  }
  return { sample(stage, counts) { notify('progress', { stage, counts, started: performance.now() }) }, step(stage, action, counts) {
    const entry = { stage, started: performance.now(), counts }
    pending.add(entry); notify('start', entry)
    const finish = (event, error) => { pending.delete(entry); notify(event, entry, error) }
    let value
    try { value = action() } catch (error) { finish('rejected', error); throw error }
    return Promise.resolve(value).then(result => { finish('settled'); return result }, error => { finish('rejected', error); throw error })
  } }
}
