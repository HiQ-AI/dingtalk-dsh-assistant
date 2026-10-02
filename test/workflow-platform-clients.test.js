import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createPlatformClients } from '../packages/dingtalk-dsh-assistant/workflow-platform-clients.js'

const SHA = 'a'.repeat(40)
const json = body => ({ ok: true, json: async () => body })
const target = { repository: 'HiQ-AI/dataset', branch: 'feature/uat3-base',
  woodpecker: { baseUrl: 'https://woodpecker.hiqdat.dev', repositoryId: 4, cronName: 'dataset-uat3-poll' } }

function approvalFixture({ status = 'APPROVED', issueStatus = 'OPEN', comments, approvers, revisedSql = false, repeatToken = false } = {}) {
  const project = 'projects/flbn', issueId = `${project}/issues/1`, planId = `${project}/plans/1`, sheetId = `${project}/sheets/1`
  const target = { instance: 'instances/flbnpguaf', database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' }
  const sql = 'ALTER TABLE public.t ADD COLUMN label character varying;'
  const sheetSha256 = createHash('sha256').update(sql).digest('hex'), packageDigest = 'b'.repeat(64)
  const operationKey = 'a'.repeat(64), scopeDigest = 'c'.repeat(64), title = `Assistant data change ${operationKey}`
  const rows = comments ?? [{ name: `${issueId}/issueComments/review-1`, creator: 'users/reviewer@example.test',
    createTime: '2026-10-02T01:00:00Z', approval: { status }, comment: '字段改为 text' }]
  let writes = 0
  const client = createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev', bytebaseToken: 'fixture',
    fetchImpl: async (url, options = {}) => {
      if (options.method && options.method !== 'GET') writes++
      const path = new URL(url).pathname
      if (path.endsWith('/issueComments')) return json({ issueComments: rows, ...(repeatToken ? { nextPageToken: 'repeat' } : {}) })
      if (path.endsWith('/issues/1')) return json({ name: issueId, plan: planId, status: issueStatus, type: 'DATABASE_CHANGE',
        title, description: JSON.stringify({ operationKey, packageDigest, applySqlSha256: sheetSha256, target }),
        approvalStatus: status, approvers: approvers ?? [{ principal: 'users/reviewer@example.test', status }] })
      if (path.endsWith('/plans/1')) return json({ name: planId, issue: issueId, title,
        specs: [{ id: 'spec-1', changeDatabaseConfig: { targets: [target.database], sheet: sheetId } }] })
      if (path.endsWith('/sheets/1')) return json({ name: sheetId, content: Buffer.from(revisedSql ? `${sql} -- changed` : sql).toString('base64') })
      throw Error('unexpected request')
    } }).bytebase
  return { client, input: { project, issueId, planId, sheetId, sheetSha256, target, packageDigest, scopeDigest }, writes: () => writes }
}

test('Bytebase 真人审批独立回读当前 SQL 和审批人事件，不发送批准或执行', async () => {
  const fixture = approvalFixture()
  const view = await fixture.client.getIssueApproval(fixture.input)
  assert.equal(view.decision, 'approved')
  assert.equal(view.source, 'bytebase')
  assert.equal(view.human, true)
  assert.equal(view.decidedBy, 'users/reviewer@example.test')
  assert.equal(view.sheetSha256, fixture.input.sheetSha256)
  assert.equal(fixture.writes(), 0)
})

test('Bytebase pending 和 SKIPPED 区分待审与未配置，均无真人批准', async () => {
  for (const [status, decision] of [['PENDING', 'pending'], ['CHECKING', 'pending'], ['SKIPPED', 'unconfigured']]) {
    const fixture = approvalFixture({ status })
    const view = await fixture.client.getIssueApproval(fixture.input)
    assert.equal(view.decision, decision)
    assert.equal(view.human, false)
    assert.equal(fixture.writes(), 0)
  }
  const done = approvalFixture({ status: 'SKIPPED', issueStatus: 'DONE' })
  assert.equal((await done.client.getIssueApproval(done.input)).decision, 'unconfigured')
  const canceled = approvalFixture({ status: 'APPROVED', issueStatus: 'CANCELED' })
  await assert.rejects(canceled.client.getIssueApproval(canceled.input), /BYTEBASE_APPROVAL_ISSUE_NOT_ACTIVE/)
})

test('Bytebase 驳回返回真实意见及审批事件，供修订后重新送审', async () => {
  const fixture = approvalFixture({ status: 'REJECTED' })
  const view = await fixture.client.getIssueApproval(fixture.input)
  assert.equal(view.decision, 'rejected')
  assert.equal(view.comment, '字段改为 text')
  assert.match(view.requestId, /issueComments\/review-1$/)
})

test('Bytebase SQL 变化、缺少人审批事件或修订后的旧批准不能执行', async () => {
  for (const options of [{ revisedSql: true }, { comments: [] }, { approvers: [] },
    { comments: [{ name: 'projects/flbn/issues/1/issueComments/a', creator: 'users/reviewer@example.test',
      createTime: '2026-10-02T01:00:00Z', approval: { status: 'APPROVED' } },
    { name: 'projects/flbn/issues/1/issueComments/b', createTime: '2026-10-02T02:00:00Z', planSpecUpdate: {} }] }]) {
    const fixture = approvalFixture(options)
    await assert.rejects(fixture.client.getIssueApproval(fixture.input), /BYTEBASE_(SHEET|HUMAN_APPROVAL)_UNCONFIRMED/)
    assert.equal(fixture.writes(), 0)
  }
})

test('Bytebase 审批评论分页重复游标报错，不能截断后误认批准', async () => {
  const fixture = approvalFixture({ repeatToken: true })
  await assert.rejects(fixture.client.getIssueApproval(fixture.input), /BYTEBASE_APPROVAL_COMMENTS_INCOMPLETE/)
})

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
    successfulSyncTime: new Date().toISOString() }
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

test('Bytebase 工单以 operationKey 唯一对账，执行前检查任务且独立回读结果', async () => {
  const target = { instance: 'instances/flbnpguaf',
    database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' }
  const project = 'projects/flbn', issueId = `${project}/issues/1`, planId = `${project}/plans/1`
  const sheetId = `${project}/sheets/1`, taskId = `${planId}/rollout/stages/prod/tasks/1`
  const operationKey = 'a'.repeat(64), packageDigest = 'b'.repeat(64)
  const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1'
  const applySqlSha256 = createHash('sha256').update(applySql).digest('hex')
  const title = `Assistant data change ${operationKey}`
  let created = false, activated = false, ran = false
  const writes = []
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname
    const method = options.method ?? 'GET'
    if (method === 'POST') writes.push(path)
    if (path === `/v1/${target.database}`) return json({ name: target.database, project,
      instanceResource: { name: target.instance }, effectiveEnvironment: 'environments/prod' })
    if (path === '/v1/environments/prod/policies/rollout_policy') return json({ name: 'environments/prod/policies/rollout_policy',
      type: 'ROLLOUT_POLICY', resourceType: 'ENVIRONMENT', rolloutPolicy: { automatic: false } })
    if (path.endsWith('/issues') && method === 'GET') return json({ issues: created
      ? [{ name: issueId, title }] : [] })
    if (path.endsWith('/sheets') && method === 'POST') return json({ name: sheetId })
    if (path.endsWith('/plans') && method === 'POST') return json({ name: planId })
    if (path.endsWith('/rollout') && method === 'POST') { activated = true; return json({ name: `${planId}/rollout` }) }
    if (path.endsWith('/issues') && method === 'POST') { created = true; return json({ name: issueId }) }
    if (path.endsWith('/issues/1')) return json({ name: issueId, title, type: 'DATABASE_CHANGE',
      description: JSON.stringify({ operationKey, packageDigest, applySqlSha256, target }), plan: planId })
    if (path.endsWith('/plans/1')) return json({ name: planId, issue: issueId, title, hasRollout: activated,
      specs: [{ id: 'spec-1', changeDatabaseConfig: { targets: [target.database], sheet: sheetId } }] })
    if (path.endsWith('/sheets/1')) return json({ name: sheetId,
      content: Buffer.from(applySql).toString('base64') })
    if (path.endsWith('/rollout')) return json({ name: `${planId}/rollout`, stages: [{
      environment: 'environments/prod', tasks: [{ name: taskId, specId: 'spec-1',
        target: target.database, databaseUpdate: { sheet: sheetId },
        status: ran ? 'DONE' : 'NOT_STARTED' }] }] })
    if (path.endsWith('/taskRuns')) return json({ taskRuns: ran
      ? [{ name: `${taskId}/taskRuns/1`, status: 'DONE' }] : [] })
    if (path.endsWith('/tasks:batchRun')) { ran = true; return json({}) }
    if (path.endsWith(':query')) return json({ results: [{ columnNames: ['v'],
      rows: [{ values: [{ int32Value: 2 }] }] }] })
    throw new Error(`unexpected ${method} ${path}`)
  }
  const client = createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev',
    bytebaseToken: 'fixture-token', fetchImpl }).bytebase
  const createdBundle = await client.createIssueBundle({ project, target, operationKey,
    packageDigest, applySqlSha256, applySql })
  assert.equal(createdBundle.issue.id, issueId)
  assert.equal(createdBundle.task, null)
  assert.equal(createdBundle.sheet.sha256, applySqlSha256)
  assert.equal(writes.filter(path => path.endsWith('/rollout')).length, 0)
  assert.equal(writes.filter(path => path.endsWith('/issues')).length, 1)
  const same = await client.createIssueBundle({ project, target, operationKey,
    packageDigest, applySqlSha256, applySql })
  assert.deepEqual(same, createdBundle)
  assert.equal(writes.filter(path => path.endsWith('/issues')).length, 1)
  const approvalRequestId = `${issueId}/issueComments/approval-1`
  const executionIdentity = { issueCreationOperationKey: operationKey, approvalRequestId, planId, sheetId, target, applySqlSha256, packageDigest,
    executeOperationKey: executionDigest({ stage: 'execute-task', packageDigest, issueId, approvalRequestId }) }
  await assert.rejects(client.activateRollout({ project, issueId, ...executionIdentity, issueCreationOperationKey: 'c'.repeat(64) }), /BYTEBASE_ROLLOUT_IDENTITY_CHANGED/)
  await assert.rejects(client.activateRollout({ project, issueId, ...executionIdentity, executeOperationKey: operationKey }), /BYTEBASE_ROLLOUT_IDENTITY_CHANGED/)
  const activatedBundle = await client.activateRollout({ project, issueId, ...executionIdentity })
  assert.equal(activatedBundle.task.id, taskId)
  assert.equal(writes.filter(path => path.endsWith('/rollout')).length, 1)
  assert.deepEqual(await client.activateRollout({ project, issueId, ...executionIdentity }), activatedBundle)
  assert.equal(writes.filter(path => path.endsWith('/rollout')).length, 1)
  await client.runTask({ project, issueId, taskId, ...executionIdentity })
  assert.equal(writes.filter(path => path.endsWith('/tasks:batchRun')).length, 1)
  assert.deepEqual(await client.runTask({ project, issueId, taskId, ...executionIdentity }), { taskId })
  assert.equal(writes.filter(path => path.endsWith('/tasks:batchRun')).length, 1)
  const execution = await client.getTaskExecution({ project, issueId, taskId })
  assert.equal(execution.taskRun.status, 'DONE')
  const verification = await client.queryVerification({ project, target,
    sql: 'SELECT v FROM public.t WHERE id = 1', taskRunId: execution.taskRun.id,
    expectedChange: '{"rows":[{"v":2}]}' })
  assert.equal(verification.observedChange, '[{"v":2}]')
  assert.equal(verification.packageDigest, packageDigest)
})

test('Bytebase 工单首步结果未知时拒绝再次发送写请求', async () => {
  const project = 'projects/flbn', target = { instance: 'instances/flbnpguaf',
    database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' }
  let writes = 0
  const client = createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev',
    bytebaseToken: 'fixture-token', fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') { writes++; throw new Error('uncertain') }
      const path = new URL(url).pathname
      if (path === `/v1/${target.database}`) return json({ name: target.database, project,
        instanceResource: { name: target.instance }, effectiveEnvironment: 'environments/prod' })
      if (path === '/v1/environments/prod/policies/rollout_policy') return json({ name: 'environments/prod/policies/rollout_policy',
        type: 'ROLLOUT_POLICY', resourceType: 'ENVIRONMENT', rolloutPolicy: { automatic: false } })
      return json({ issues: [] })
    } }).bytebase
  const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1'
  const request = { project, target, operationKey: 'a'.repeat(64), packageDigest: 'b'.repeat(64),
    applySql, applySqlSha256: createHash('sha256').update(applySql).digest('hex') }
  await assert.rejects(client.createIssueBundle(request), /PLATFORM_REQUEST_FAILED/)
  await assert.rejects(client.createIssueBundle(request), /BYTEBASE_CREATE_RESULT_UNKNOWN/)
  assert.equal(writes, 1)
})

test('送审前读取原生环境执行策略，AUTO、拒读及畸形策略均零Sheet/Plan/Issue写入', async () => {
  const project = 'projects/flbn', target = { instance: 'instances/flbnpguaf',
    database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' }
  for (const mode of ['auto', 'denied', 'malformed']) {
    let writes = 0
    const client = createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev', bytebaseToken: 'fixture',
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'POST') { writes++; throw Error('UNEXPECTED_WRITE') }
        const path = new URL(url).pathname
        if (path.endsWith('/issues')) return json({ issues: [] })
        if (path === `/v1/${target.database}`) return json({ name: target.database, project,
          instanceResource: { name: target.instance }, effectiveEnvironment: 'environments/prod' })
        if (path.endsWith('/policies/rollout_policy')) {
          if (mode === 'denied') return { ok: false, status: 403 }
          return json({ name: 'environments/prod/policies/rollout_policy', type: 'ROLLOUT_POLICY',
            resourceType: 'ENVIRONMENT', ...(mode === 'malformed' ? {} : { rolloutPolicy: { automatic: true } }) })
        }
        throw Error('UNEXPECTED_READ')
      } }).bytebase
    const applySql = 'ALTER TABLE public.t ADD COLUMN name text;'
    await assert.rejects(client.createIssueBundle({ project, target, operationKey: 'a'.repeat(64), packageDigest: 'b'.repeat(64),
      applySql, applySqlSha256: createHash('sha256').update(applySql).digest('hex') }),
    mode === 'auto' ? /BYTEBASE_AUTOMATIC_ROLLOUT_NOT_ALLOWED_FOR_REVIEW/ : /BYTEBASE_ROLLOUT_POLICY_UNCONFIRMED/)
    assert.equal(writes, 0)
  }
})

test('Bytebase Rollout 提交结果未知时禁止重发，留给只读对账', async () => {
  const project = 'projects/flbn', issueId = `${project}/issues/1`, planId = `${project}/plans/1`
  const target = { instance: 'instances/flbnpguaf',
    database: 'instances/flbnpguaf/databases/hiq_editor', environment: 'production' }
  const applySql = 'UPDATE public.t SET v = 2 WHERE id = 1'
  const operationKey = 'a'.repeat(64)
  let writes = 0
  const client = createPlatformClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev',
    bytebaseToken: 'fixture-token', fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname
      if (options.method === 'POST') { writes++; throw new Error('uncertain') }
      if (path.endsWith('/issues/1')) return json({ name: issueId,
        title: `Assistant data change ${operationKey}`, type: 'DATABASE_CHANGE', plan: planId,
        description: JSON.stringify({ operationKey, packageDigest: 'b'.repeat(64),
          applySqlSha256: createHash('sha256').update(applySql).digest('hex'), target }) })
      if (path.endsWith('/plans/1')) return json({ name: planId, issue: issueId,
        title: `Assistant data change ${operationKey}`, hasRollout: false,
        specs: [{ id: 'spec-1', changeDatabaseConfig: { targets: [target.database],
          sheet: `${project}/sheets/1` } }] })
      if (path.endsWith('/sheets/1')) return json({ name: `${project}/sheets/1`,
        content: Buffer.from(applySql).toString('base64') })
      throw new Error(`unexpected ${path}`)
    } }).bytebase
  const approvalRequestId = `${issueId}/issueComments/approval-1`, executionIdentity = { issueCreationOperationKey: operationKey, approvalRequestId, planId, sheetId: `${project}/sheets/1`, target,
    applySqlSha256: createHash('sha256').update(applySql).digest('hex'), packageDigest: 'b'.repeat(64),
    executeOperationKey: executionDigest({ stage: 'execute-task', packageDigest: 'b'.repeat(64), issueId, approvalRequestId }) }
  await assert.rejects(client.activateRollout({ project, issueId, ...executionIdentity }), /PLATFORM_REQUEST_FAILED/)
  await assert.rejects(client.activateRollout({ project, issueId, ...executionIdentity }), /BYTEBASE_ROLLOUT_RESULT_UNKNOWN/)
  assert.equal(writes, 1)
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

test('失败流水线的构建证据仅显式精确终态且build步骤成功时允许读取',async()=>{
 const imageDigest=`sha256:${'b'.repeat(64)}`
 const pipeline={number:7,commit:SHA,status:'killed',workflows:[{children:[{id:19,name:'buildkit-build-and-push',state:'success',exit_code:0}]}]}
 const logs=[`#23 exporting manifest ${imageDigest} done`,`#23 pushing manifest for registry.cn-sh1.ctyun.cn/hiq-ai/dataset:uat2@${imageDigest} 0.0s done`].map(data=>({step_id:19,data:Buffer.from(data).toString('base64')}))
 const clients=createPlatformClients({woodpeckerToken:'test',fetchImpl:async url=>json(url.endsWith('/pipelines/7')?pipeline:logs)})
 const args={baseUrl:target.woodpecker.baseUrl,repositoryId:4,pipelineNumber:7}
 await assert.rejects(clients.woodpecker.readBuildEvidence(args),/WOODPECKER_BUILD_UNCONFIRMED/)
 const result=await clients.woodpecker.readBuildEvidence({...args,expectedPipelineStatus:'killed'});assert.equal(result.pipelineStatus,'killed');assert.equal(result.buildStepStatus,'success');assert.equal(result.buildStepExitCode,0)
 await assert.rejects(clients.woodpecker.readBuildEvidence({...args,expectedPipelineStatus:'running'}),/WOODPECKER_PIPELINE_INVALID/)
 await assert.rejects(clients.woodpecker.readBuildEvidence({...args,expectedPipelineStatus:'failure'}),/WOODPECKER_BUILD_UNCONFIRMED/)
 pipeline.workflows[0].children[0].state='killed';await assert.rejects(clients.woodpecker.readBuildEvidence({...args,expectedPipelineStatus:'killed'}),/WOODPECKER_BUILD_STEP_UNCONFIRMED/)
 pipeline.workflows[0].children[0].state='success';pipeline.workflows[0].children[0].exit_code=1;await assert.rejects(clients.woodpecker.readBuildEvidence({...args,expectedPipelineStatus:'killed'}),/WOODPECKER_BUILD_STEP_UNCONFIRMED/)
 pipeline.workflows[0].children[0].exit_code=0;logs[0].step_id=20;await assert.rejects(clients.woodpecker.readBuildEvidence({...args,expectedPipelineStatus:'killed'}),/WOODPECKER_BUILD_LOG_INVALID/)
})
