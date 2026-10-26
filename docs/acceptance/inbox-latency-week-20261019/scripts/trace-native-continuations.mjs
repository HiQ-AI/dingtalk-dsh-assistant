// Diagnostic only: preserve assertions; trace native progress with a larger observation window.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (!url.endsWith('/test/task-session-service-native.test.js')) return result
  const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source)
  if (source.includes('INBOX_32_DIAGNOSTIC')) return result
  const start = source.indexOf("test('32 continuations bound owner Host input")
  const end = source.indexOf("test('configured group responsibility", start)
  if (start < 0 || end < 0) throw new Error('trace_target_not_found')
  let fragment = source.slice(start, end)
  fragment = fragment.replace(/\{ timeout: \d+ \}/, '{ timeout: 600000 }')
  fragment = fragment.replace('let ownerSteps = 0', 'let ownerSteps = 0, traceCalls = 0; const traceStart = process.hrtime.bigint() // INBOX_32_DIAGNOSTIC')
  fragment = fragment.replace('    const input = latestInput(request)', `    const input = latestInput(request)
    console.error('INBOX_32_PROGRESS ' + JSON.stringify({ ms: Number(process.hrtime.bigint() - traceStart) / 1e6,
      call: ++traceCalls, ownerSteps, owner: request.tools.some(tool => tool.name === 'task_delegate'),
      executions: (input.executions ?? []).map(item => ({ version: item.inputVersion, drained: item.drained, status: item.status })) }))`)
  return { ...result, source: source.slice(0, start) + fragment + source.slice(end) }
}
