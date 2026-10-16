import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'

// Loaded only into a synthetic service explicitly registered by its owning test.
const token = process.env.DSH_TEST_SERVICE_TOKEN
if (token && process.send) {
  const servers = new Set()
  const createServer = http.createServer
  http.createServer = function (...args) {
    const server = Reflect.apply(createServer, this, args)
    servers.add(server)
    server.once('close', () => servers.delete(server))
    return server
  }
  syncBuiltinESMExports()
  let closing
  const close = () => closing ??= (async () => {
    await Promise.all([...servers].map(server => new Promise((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections?.()
    })))
    if (process.connected) process.disconnect()
  })()
  process.on('message', message => {
    if (message?.type === 'dsh-test-service-close' && message.token === token)
      void close().catch(error => { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect() })
  })
  process.once('disconnect', () => { void close().catch(error => { console.error(error); process.exitCode = 1 }) })
  process.channel?.unref()
}
