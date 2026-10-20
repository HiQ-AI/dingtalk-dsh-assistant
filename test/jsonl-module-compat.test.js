import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const run = promisify(execFile)
const probe = fileURLToPath(new URL('./fixtures/jsonl-module-compat.js', import.meta.url))
for (const [version, profile] of [
  ['0.2.1-alpha.2', resolve('package.json')],
  ['0.2.1-rc.2', process.env.DSH_JSONL_RC2_PROFILE],
]) test(`real ${version} JSONL exports, Resident import and task persistence roundtrip`, { skip: !profile ? 'Set DSH_JSONL_RC2_PROFILE to a separately installed official rc.2 package.json' : false }, async () => {
  const { stdout } = await run(process.execPath, [probe, profile, version], { timeout: 30000, maxBuffer: 1024 * 1024 })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(result.version, version)
  assert.ok(result.nativeModuleCount > 1)
  console.log(JSON.stringify(result))
})
