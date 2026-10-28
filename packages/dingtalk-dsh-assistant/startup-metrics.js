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
