import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
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

test('木啄构建证明只从精确成功步骤读取结构化 digest', async () => {
  const imageDigest = `sha256:${'b'.repeat(64)}`
  const pipeline = { number: 7, commit: SHA, status: 'success', workflows: [
    { children: [{ id: 19, name: 'buildkit-build-and-push', state: 'success', exit_code: 0 }] },
  ] }
  const logs = [
    `#23 exporting manifest ${imageDigest} done`,
    `#23 pushing manifest for registry.cn-sh1.ctyun.cn/hiq-ai/dataset:uat2@${imageDigest} 0.0s done`,
  ].map(data => ({ step_id: 19, data: Buffer.from(data).toString('base64') }))
  logs.splice(1, 0, { step_id: 19, data: null })
  const fetchImpl = async url => json(url.endsWith('/pipelines/7') ? pipeline : logs)
  const clients = createPlatformClients({ woodpeckerToken: 'test', fetchImpl })
  const result = await clients.woodpecker.readBuildEvidence({ baseUrl: target.woodpecker.baseUrl,
    repositoryId: 4, pipelineNumber: 7 })
  assert.equal(result.commitSha, SHA)
  assert.equal(result.imageDigest, imageDigest)
  assert.match(result.evidenceRef, /^woodpecker-build:/)
  const missing = createPlatformClients({ woodpeckerToken: 'test', fetchImpl: async url =>
    json(url.endsWith('/pipelines/7') ? pipeline : [{ step_id: 19, data: Buffer.from('pushed :uat2').toString('base64') }]) })
  await assert.rejects(missing.woodpecker.readBuildEvidence({ baseUrl: target.woodpecker.baseUrl,
    repositoryId: 4, pipelineNumber: 7 }), /WOODPECKER_BUILD_DIGEST_UNCONFIRMED/)
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

test('GitHub 标签 404 仅在仓库独立可读时判不存在', async () => {
  const clients = createPlatformClients({ fetchImpl: async url => url.includes('/git/ref/tags/')
    ? { status: 404, ok: false } : json({ full_name: 'HiQ-AI/dataset' }) })
  const row = await clients.github.readTag({ repository: 'HiQ-AI/dataset', tag: 'v20260925-1' })
  assert.equal(row.exists, false)
})

test('Kubernetes Pod 仅接受属于目标 Deployment ReplicaSet 的 imageID', async () => {
  const observed = []
  const clients = createPlatformClients({ kubeconfig: 'C:/kubeconfig', execFileImpl: async (_, args) => {
    observed.push(args)
    const kind = args[args.indexOf('get') + 1]
    if (kind === 'replicasets') return { stdout: JSON.stringify({ items: [{ metadata: { uid: 'rs1',
      ownerReferences: [{ kind: 'Deployment', uid: 'dep1', name: 'dataset' }] } }] }) }
    return { stdout: JSON.stringify({ items: [{ metadata: { resourceVersion: '10',
      ownerReferences: [{ kind: 'ReplicaSet', uid: 'rs1' }] }, spec: { containers: [{ name: 'app' }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true,
        imageID: `registry/image@sha256:${'b'.repeat(64)}` }] } }] }) }
  } })
  const row = await clients.kubernetes.readPods({ namespace: 'uat', deployment: 'dataset', deploymentUid: 'dep1' })
  assert.equal(row.pods[0].imageDigest, `sha256:${'b'.repeat(64)}`)
  assert.equal(row.pods[0].ready, true)
  assert.equal(observed.some(args => args.includes('--insecure-skip-tls-verify')), false)
})

test('OCI manifest index 独立验证内容摘要并只选真实平台', async () => {
  const platform = `sha256:${'b'.repeat(64)}`
  const bytes = Buffer.from(JSON.stringify({ manifests: [
    { digest: platform, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'c'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
  ] }))
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const clients = createPlatformClients({ registryBearerToken: 'test', fetchImpl: async () => ({
    ok: true, headers: { get: () => digest }, arrayBuffer: async () => bytes,
  }) })
  const row = await clients.registry.readManifest({ image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset', digest })
  assert.deepEqual(row.platformDigests, [platform])
})

test('Bytebase 数据库身份只取平台实测项目、实例与环境，不用请求环境补齐', async () => {
  const production = { instance: 'instances/flbnpguaf',
    database: 'instances/flbnpguaf/databases/hiq_background_db', environment: 'production' }
  const observed = { name: production.database, project: 'projects/flbn',
    effectiveEnvironment: 'environments/prod', instanceResource: { name: production.instance },
    successfulSyncTime: '2026-09-25T00:00:00Z' }
  const create = row => createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev',
    bytebaseToken: 'fixture-token', fetchImpl: async () => json(row) }).bytebase
  const result = await create(observed).getDatabase({ project: 'projects/flbn', target: production })
  assert.deepEqual({ project: result.project, instance: result.instance, database: result.database,
    environment: result.environment }, { project: 'projects/flbn', ...production })
  assert.match(result.evidenceRef, /^bytebase-database:/)
  for (const changed of [
    { project: 'projects/other' },
    { name: 'instances/flbnpguaf/databases/other' },
    { effectiveEnvironment: 'environments/uat' },
    { instanceResource: { name: 'instances/other' } },
    { effectiveEnvironment: undefined },
  ]) await assert.rejects(create({ ...observed, ...changed }).getDatabase({
    project: 'projects/flbn', target: production }), /BYTEBASE_DATABASE_IDENTITY_UNCONFIRMED/)
  await assert.rejects(create(observed).getDatabase({ project: 'projects/flbn',
    target: { ...production, environment: 'uat' } }), /BYTEBASE_DATABASE_IDENTITY_UNCONFIRMED/)
})

test('本机 Docker 凭据只读 OCI 原始清单并校验字节摘要', async () => {
  const platform = `sha256:${'d'.repeat(64)}`
  const bytes = Buffer.from(JSON.stringify({ manifests: [{ digest: platform,
    platform: { os: 'linux', architecture: 'amd64' } }] }))
  const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const calls = []
  const clients = createPlatformClients({ registryDockerCliEnabled: true,
    execFileImpl: async (name, args) => { calls.push([name, args]); return { stdout: bytes } } })
  const row = await clients.registry.readManifest({ image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset', digest: expected })
  assert.equal(row.digest, expected)
  assert.deepEqual(row.platformDigests, [platform])
  assert.deepEqual(calls, [['docker', ['buildx', 'imagetools', 'inspect', '--raw',
    `registry.cn-sh1.ctyun.cn/hiq-ai/dataset@${expected}`]]])
  await assert.rejects(clients.registry.readManifest({ image: 'registry.cn-sh1.ctyun.cn/hiq-ai/dataset',
    digest: `sha256:${'e'.repeat(64)}` }), /REGISTRY_DIGEST_MISMATCH/)
})
