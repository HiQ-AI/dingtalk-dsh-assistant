import { setTimeout as delay } from 'node:timers/promises'

const pid = Number(process.argv[2]), seconds = Number(process.argv[3] ?? 20)
if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw new Error('usage: node profile-resident.mjs <pid> [seconds] [--check]')
process.kill(pid, 0)
const endpoint = 'http://127.0.0.1:9229/json/list'
const targets = async () => {
  try { const response = await fetch(endpoint, { signal: AbortSignal.timeout(1000) }); return await response.json() }
  catch { return null }
}
let entries = await targets()
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ pid, seconds, existingInspector: !!entries, action: 'sample CPU without pausing or restarting; close only inspector opened by this script' }))
  process.exit(0)
}
const opened = !entries
if (entries) throw new Error('inspector_already_in_use')
let socket, verified = false, id = 0
const pending = new Map()
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id
  pending.set(requestId, { resolve, reject })
  socket.send(JSON.stringify({ id: requestId, method, params }))
})
try {
  if (opened) {
    process._debugProcess(pid)
    for (let attempt = 0; attempt < 30 && !entries; attempt++) { await delay(100); entries = await targets() }
  }
  if (!entries?.[0]?.webSocketDebuggerUrl) throw new Error('inspector_not_available')
  socket = new WebSocket(entries[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data), request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.error) request.reject(new Error(JSON.stringify(response.error)))
    else request.resolve(response.result)
  })
  const identity = await rpc('Runtime.evaluate', { expression: 'process.pid', returnByValue: true })
  if (identity.result?.value !== pid) throw new Error('inspector_pid_mismatch')
  verified = true
  await rpc('Profiler.enable')
  await rpc('Profiler.start')
  console.log(JSON.stringify({ status: 'sampling', pid, seconds, openedInspector: opened }))
  await delay(seconds * 1000)
  const { profile } = await rpc('Profiler.stop')
  await rpc('Profiler.disable')
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const exclusive = new Map(), inclusive = new Map()
  for (let index = 0; index < profile.samples.length; index++) {
    let current = profile.samples[index], weight = profile.timeDeltas[index] ?? 1000
    exclusive.set(current, (exclusive.get(current) ?? 0) + weight)
    while (current !== undefined) { inclusive.set(current, (inclusive.get(current) ?? 0) + weight); current = parents.get(current) }
  }
  const total = profile.endTime - profile.startTime
  const top = values => [...values].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([nodeId, micros]) => {
    const frame = nodes.get(nodeId).callFrame
    return { function: frame.functionName || '(anonymous)', url: frame.url, line: frame.lineNumber + 1, ms: Math.round(micros / 1000), percent: +(100 * micros / total).toFixed(1) }
  })
  console.log(JSON.stringify({ durationMs: Math.round(total / 1000), exclusive: top(exclusive), inclusive: top(inclusive) }, null, 2))
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    if (opened && verified) await rpc('Runtime.evaluate', { expression: "setImmediate(() => process.getBuiltinModule('node:inspector').close()); 'closing'" })
    socket.close()
  }
}
