import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { performance } from 'node:perf_hooks'
const totals = new Map()
for (const name of ['lstat', 'realpath', 'readdir', 'readFile', 'open', 'mkdir']) {
  const original = fs[name]
  fs[name] = async function (...args) {
    const start = performance.now()
    try { return await original.apply(this, args) }
    finally {
      const entry = totals.get(name) ?? { calls: 0, elapsedMs: 0 }
      entry.calls++; entry.elapsedMs += performance.now() - start
      totals.set(name, entry)
    }
  }
}
syncBuiltinESMExports()
process.on('exit', () => console.log(JSON.stringify({ filesystemProfile: Object.fromEntries([...totals].map(([key, item]) => [key, { calls: item.calls, elapsedMs: Math.round(item.elapsedMs) }])) })))
