import test from 'node:test'
import assert from 'node:assert/strict'
import { configure } from './configure-frontend-pipeline-timeout.mjs'
const commit = 'd1e447787201212140a2732b798d336965ddfaa7'
function fixture(overrides = {}) {
  const calls = [], repo = { id: 2, full_name: 'HiQ-AI/dataset-web', timeout: 10, ...overrides.repo }
  return { calls, args: { apply: true, api: async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'PATCH') { assert.deepEqual(body, { timeout: 30 }); repo.timeout = 30; return { ...repo } }
    if (path.endsWith('/permissions')) return { admin: overrides.admin ?? true }
    if (path.endsWith('/319')) return { number: 319, commit, branch: 'feature/uat2-base', status: 'killed', started: 1, finished: 601, ...overrides.pipeline }
    return { ...repo }
  }, listPipelines: async () => overrides.scan ?? { complete: true, pipelines: [{ status: 'killed' }] },
  readBranch: async () => ({ commitSha: overrides.branch ?? commit }), reserve: async () => { calls.push({ reserve: true }); if (overrides.reserved) throw Error('ALREADY_RESERVED') } } }
}
test('check never reserves or writes', async () => {
  const f = fixture(); const result = await configure({ ...f.args, apply: false })
  assert.equal(result.writes, 0); assert.equal(f.calls.some(c => c.reserve || c.method === 'PATCH'), false)
})
test('one timeout-only patch and independent readback', async () => {
  const f = fixture(); assert.equal((await configure(f.args)).verified, true)
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1)
  assert.deepEqual(f.calls.at(-1), { method: 'GET', path: 'repos/2', body: undefined })
})
test('already applied is read-only', async () => {
  const f = fixture({ repo: { timeout: 30 } }); assert.equal((await configure(f.args)).alreadyApplied, true)
  assert.equal(f.calls.some(c => c.reserve || c.method === 'PATCH'), false)
})
test('scope, failure proof, live build and permissions fail before write', async () => {
  for (const options of [{ repo: { id: 1 } }, { repo: { timeout: 20 } }, { pipeline: { status: 'running' } }, { pipeline: { commit: 'a'.repeat(40) } }, { scan: { complete: false, pipelines: [] } }, { scan: { complete: true, pipelines: [{ status: 'running' }] } }, { admin: false }, { branch: 'b'.repeat(40) }]) {
    const f = fixture(options); await assert.rejects(configure(f.args)); assert.equal(f.calls.some(c => c.reserve || c.method === 'PATCH'), false)
  }
})
test('prior intent forbids another patch', async () => {
  const f = fixture({ reserved: true }); await assert.rejects(configure(f.args), /ALREADY_RESERVED/)
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false)
})
