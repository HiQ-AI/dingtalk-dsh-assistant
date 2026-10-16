import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { trackTestService } from './fixtures/owned-test-service.js'

test('synthetic service owner closes its retained child naturally without process enumeration', async t => {
  let child
  await t.test('own a real HTTP service', async owner => {
    const service = { executable: process.execPath, args: ['-e', "const s=require('node:http').createServer((q,r)=>r.end('fixture'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"] }
    trackTestService(owner, service, process.cwd())
    child = spawn(service.executable, service.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const [data] = await once(child.stdout, 'data')
    assert.ok(child.connected)
    assert.equal(await (await fetch(`http://127.0.0.1:${Number(data.toString().trim())}`)).text(), 'fixture')
  })
  assert.equal(child.exitCode, 0)
  assert.equal(child.signalCode, null)
  assert.equal(child.connected, false)
})

test('service lifecycle fixture leaves matching commands outside the owner root unchanged', async t => {
  const service = { executable: process.execPath, args: ['-e', 'console.log("unrelated")'] }
  trackTestService(t, service, fileURLToPath(new URL('./fixtures/', import.meta.url)))
  const child = spawn(service.executable, service.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const closed = once(child, 'close')
  assert.equal(child.connected, false)
  assert.deepEqual(await closed, [0, null])
})
