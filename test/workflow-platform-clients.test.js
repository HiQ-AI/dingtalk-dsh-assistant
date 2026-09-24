import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlatformClients } from '../packages/dingtalk-dsh-assistant/workflow-platform-clients.js'

const SHA = 'a'.repeat(40)
const json = body => ({ ok: true, json: async () => body })
const target = { repository: 'HiQ-AI/dataset', branch: 'feature/uat3-base',
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 4, cronName: 'dataset-uat3-poll' } }

test('木啄只读全量分页并过滤私有 variables', async () => {
  const calls = []
  const clients = createPlatformClients({ woodpeckerToken: 'test', fetchImpl: async url => {
    calls.push(url)
    return json(url.includes('page=1') ? [{ number: 7, commit: SHA, branch: target.branch,
      status: 'failure', variables: { secret: 'must-not-leak' } }] : [])
  } })
  const list = await clients.woodpecker.listPipelines({ baseUrl: target.woodpecker.baseUrl, repositoryId: 4 })
  assert.equal(list.complete, true)
  assert.equal(list.pipelines.length, 1)
  assert.equal(JSON.stringify(list).includes('must-not-leak'), false)
  assert.equal(calls.length, 2)
})

test('UAT 触发前独立回读分支、流水线和 Cron', async () => {
  const calls = []
  const clients = createPlatformClients({ githubToken: 'test', woodpeckerToken: 'test', fetchImpl: async (url, options) => {
    calls.push([url, options.method ?? 'GET'])
    if (url.includes('/branches/')) return json({ commit: { sha: SHA } })
    if (url.includes('/pipelines?')) return json([])
    if (url.endsWith('/cron')) return json([{ id: 17, name: target.woodpecker.cronName, branch: target.branch }])
    if (url.endsWith('/cron/17')) return json({ number: 99 })
    throw Error('unexpected request')
  } })
  const receipt = await clients.woodpecker.triggerBuild({ target, commitSha: SHA })
  assert.match(receipt.evidenceRef, /^woodpecker-cron-dispatch:/)
  assert.deepEqual(calls.map(([, method]) => method), ['GET', 'GET', 'GET', 'POST'])
})

test('同 SHA 已有在途构建时拒绝触发', async () => {
  let posts = 0
  const clients = createPlatformClients({ fetchImpl: async (url, options) => {
    if (options.method === 'POST') posts++
    if (url.includes('/branches/')) return json({ commit: { sha: SHA } })
    if (url.includes('page=1')) return json([{ number: 5, commit: SHA, branch: target.branch, status: 'running' }])
    return json([])
  } })
  await assert.rejects(clients.woodpecker.triggerBuild({ target, commitSha: SHA }), /WOODPECKER_EQUIVALENT_BUILD_EXISTS/)
  assert.equal(posts, 0)
})

test('未验证的生产标签、镜像证明和审批拒绝执行', async () => {
  const clients = createPlatformClients()
  assert.equal(clients.github.createTag, undefined)
  assert.equal(clients.registry.readManifest, undefined)
  assert.equal(clients.attestations.read, undefined)
})
